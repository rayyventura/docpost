output "db_instance_endpoint" {
  description = "Connection endpoint for the RDS instance (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "db_instance_address" {
  description = "Hostname of the RDS instance."
  value       = aws_db_instance.main.address
}

output "db_instance_identifier" {
  description = "Identifier of the RDS instance."
  value       = aws_db_instance.main.identifier
}

output "db_instance_arn" {
  description = "ARN of the RDS instance."
  value       = aws_db_instance.main.arn
}

output "rds_proxy_endpoint" {
  description = "Connection endpoint for the RDS Proxy."
  value       = one(aws_db_proxy.main[*].endpoint)
}

output "rds_proxy_arn" {
  description = "ARN of the RDS Proxy."
  value       = one(aws_db_proxy.main[*].arn)
}

output "security_group_id" {
  description = "Security group ID of the RDS instance."
  value       = aws_security_group.rds.id
}

output "proxy_security_group_id" {
  description = "Security group ID of the RDS Proxy."
  value       = one(aws_security_group.rds_proxy[*].id)
}

output "secret_arns" {
  description = "Map of service name to Secrets Manager secret ARN for database credentials."
  value       = local.service_secret_arns
}

output "master_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the master password."
  value       = local.master_secret_arn
}
