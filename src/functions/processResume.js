const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const pdfParse = require('pdf-parse');
const path = require('path');

const processedContainerName = process.env.PROCESSED_CONTAINER || "processed";
const connectionString = process.env.AzureWebJobsStorage;

app.storageBlob('processResumeBlob', {
    path: 'resumes/{name}',
    connection: 'AzureWebJobsStorage',
    handler: async (blob, context) => {
        const fileName = context.triggerMetadata.name;
        context.log(`Resume received: Processing blob "${fileName}"`);
        
        // Skip if it's not a PDF
        if (!fileName.toLowerCase().endsWith('.pdf')) {
            context.log(`Skipping non-PDF file: ${fileName}`);
            return;
        }

        try {
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            
            // 1. Manually download the blob as a reliable Buffer
            const sourceContainerClient = blobServiceClient.getContainerClient("resumes");
            const sourceBlobClient = sourceContainerClient.getBlobClient(fileName);
            const pdfBuffer = await sourceBlobClient.downloadToBuffer();

            // 2. Extract Text using pdf-parse
            context.log('OCR started using pdf-parse');
            const data = await pdfParse(pdfBuffer);
            const rawText = data.text;
            
            context.log('OCR completed');

            // 3. Format as JSON
            // Since we are using simple OCR, we don't have structured fields like Azure AI.
            // We'll store the full text and some basic metadata.
            const outputJson = {
                metadata: {
                    originalFileName: fileName,
                    processedAt: new Date().toISOString(),
                    pageCount: data.numpages,
                    info: data.info
                },
                content: rawText
            };
            
            const jsonString = JSON.stringify(outputJson, null, 2);
            
            // 4. Upload JSON to processed container
            const containerClient = blobServiceClient.getContainerClient(processedContainerName);
            
            // Create container if it doesn't exist
            await containerClient.createIfNotExists();
            
            const newFileName = `${path.parse(fileName).name}-metadata.json`;
            const blockBlobClient = containerClient.getBlockBlobClient(newFileName);
            
            await blockBlobClient.upload(jsonString, jsonString.length);
            context.log(`Successfully processed and uploaded metadata to ${processedContainerName}/${newFileName}`);
            
        } catch (error) {
            context.log.error(`Errors occurred during processing: ${error.message}`);
            throw error;
        }
    }
});
