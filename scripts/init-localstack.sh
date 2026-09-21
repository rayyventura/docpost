#!/bin/bash
set -euo pipefail

echo "Initializing LocalStack resources..."

# S3 staging bucket with encryption
awslocal s3 mb s3://docpost-staging-local
awslocal s3api put-bucket-encryption \
  --bucket docpost-staging-local \
  --server-side-encryption-configuration '{
    "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "aws:kms"}, "BucketKeyEnabled": true}]
  }'

# SQS queues with DLQs (ADR-005, ADR-008)
# Upload events DLQ
awslocal sqs create-queue --queue-name docpost-upload-events-dlq
UPLOAD_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/docpost-upload-events-dlq --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Upload events queue
awslocal sqs create-queue --queue-name docpost-upload-events \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${UPLOAD_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

# Job queue DLQ
awslocal sqs create-queue --queue-name docpost-job-dlq
JOB_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/docpost-job-dlq --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Job queue
awslocal sqs create-queue --queue-name docpost-jobs \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${JOB_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

# Task queue DLQ
awslocal sqs create-queue --queue-name docpost-task-dlq
TASK_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/docpost-task-dlq --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Task queue
awslocal sqs create-queue --queue-name docpost-tasks \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${TASK_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

# S3 bucket notification → upload-events queue
awslocal s3api put-bucket-notification-configuration \
  --bucket docpost-staging-local \
  --notification-configuration '{
    "QueueConfigurations": [{
      "QueueArn": "arn:aws:sqs:us-east-1:000000000000:docpost-upload-events",
      "Events": ["s3:ObjectCreated:*"]
    }]
  }'

echo "LocalStack initialization complete!"
echo "S3 bucket: docpost-staging-local"
echo "SQS queues: docpost-upload-events, docpost-jobs, docpost-tasks (each with DLQ)"
