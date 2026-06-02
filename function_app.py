import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp()

RESUMES_CONTAINER = "resumes"
PROCESSED_CONTAINER = os.environ.get("PROCESSED_CONTAINER", "processed")


def get_blob_service_client() -> BlobServiceClient:
    connection_string = os.environ.get("AzureWebJobsStorage")
    if not connection_string:
        raise ValueError("AzureWebJobsStorage connection string is not configured")
    return BlobServiceClient.from_connection_string(connection_string)


@app.blob_trigger(
    arg_name="input_blob",
    path=f"{RESUMES_CONTAINER}/{{name}}",
    connection="AzureWebJobsStorage",
)
def process_resume_blob(input_blob: func.InputStream) -> None:
    """Triggered when a new PDF is uploaded to the resumes container."""
    blob_name = input_blob.name.split("/")[-1]
    file_size = input_blob.length
    upload_timestamp = datetime.now(timezone.utc).isoformat()

    logging.info(
        "Blob trigger fired for resume: %s (size: %d bytes)",
        blob_name,
        file_size,
    )

    if not blob_name.lower().endswith(".pdf"):
        logging.warning("Skipping non-PDF file: %s", blob_name)
        return

    metadata = {
        "fileName": blob_name,
        "fileSize": file_size,
        "fileSizeFormatted": f"{file_size / 1024:.2f} KB",
        "uploadTimestamp": upload_timestamp,
        "sourceContainer": RESUMES_CONTAINER,
        "contentType": "application/pdf",
        "processedAt": datetime.now(timezone.utc).isoformat(),
        "status": "processed",
    }

    metadata_blob_name = f"{blob_name.rsplit('.', 1)[0]}-metadata.json"
    metadata_json = json.dumps(metadata, indent=2)

    blob_service_client = get_blob_service_client()
    container_client = blob_service_client.get_container_client(PROCESSED_CONTAINER)
    try:
        container_client.create_container()
    except ResourceExistsError:
        pass

    blob_client = container_client.get_blob_client(metadata_blob_name)
    blob_client.upload_blob(
        metadata_json,
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )

    logging.info(
        "Metadata stored successfully: %s/%s",
        PROCESSED_CONTAINER,
        metadata_blob_name,
    )
    logging.info("Extracted metadata: %s", json.dumps(metadata))
