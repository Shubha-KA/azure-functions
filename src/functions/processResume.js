const { app } = require('@azure/functions');
const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');
const { BlobServiceClient } = require('@azure/storage-blob');

const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;
const apiKey = process.env.DOCUMENT_INTELLIGENCE_API_KEY;
const processedContainerName = process.env.PROCESSED_CONTAINER || "processed";
const connectionString = process.env.AzureWebJobsStorage;

app.storageBlob('processResumeBlob', {
    path: 'resumes/{name}',
    connection: 'AzureWebJobsStorage',
    handler: async (blob, context) => {
        const fileName = context.triggerMetadata.name;
        context.log(`Resume received: Processing blob "${fileName}" (size: ${blob.length} bytes)`);

        if (!fileName.toLowerCase().endsWith('.pdf')) {
            context.log.warn(`Skipping non-PDF file: ${fileName}`);
            return;
        }

        try {
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            
            // 1. Manually download the blob as a reliable Buffer
            const sourceContainerClient = blobServiceClient.getContainerClient("resumes");
            const sourceBlobClient = sourceContainerClient.getBlobClient(fileName);
            const pdfBuffer = await sourceBlobClient.downloadToBuffer();

            // 2. OCR Started
            context.log('OCR started');
            const client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(apiKey));
            
            // Send the reliable blob buffer to Document Intelligence using prebuilt-read
            const poller = await client.beginAnalyzeDocument("prebuilt-read", pdfBuffer);
            
            // Poll for completion
            const { content: rawText } = await poller.pollUntilDone();
            
            // OCR Completed
            context.log('OCR completed');
            context.log(`Text length extracted: ${rawText.length} characters`);

            // 2. Create JSON Document
            const uploadTimestamp = new Date().toISOString();
            const outputJson = {
                file_name: fileName,
                upload_timestamp: uploadTimestamp,
                raw_text: rawText
            };

            const jsonString = JSON.stringify(outputJson, null, 2);
            
            // 3. Upload JSON to processed container
            const containerClient = blobServiceClient.getContainerClient(processedContainerName);
            
            // Create container if it doesn't exist
            await containerClient.createIfNotExists();
            
            const outputBlobName = `${fileName.split('.').slice(0, -1).join('.')}-metadata.json`;
            const blockBlobClient = containerClient.getBlockBlobClient(outputBlobName);
            
            await blockBlobClient.upload(jsonString, Buffer.byteLength(jsonString), {
                blobHTTPHeaders: { blobContentType: "application/json" }
            });
            
            context.log('JSON stored successfully');

        } catch (error) {
            context.log.error('Errors occurred during processing:', error.message);
            throw error;
        }
    }
});
