# DocPost Terraform Bootstrap

This directory provisions the remote state backend (S3 + DynamoDB) that all other Terraform configurations depend on. This is a **one-time manual step**.

## Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.5 installed

## Usage

```bash
cd bootstrap
terraform init
terraform apply
```

After `terraform apply` completes, copy the output values into the backend configuration blocks in `infra/envs/dev/main.tf` and `infra/envs/prod/main.tf`.

## Outputs

| Output             | Description                                  |
|--------------------|----------------------------------------------|
| `state_bucket_name`| S3 bucket name for Terraform state           |
| `lock_table_name`  | DynamoDB table name for state locking         |
| `region`           | AWS region where the backend was created      |
