output "db_instance_endpoint" {
  description = "Connection endpoint for the RDS instance (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "db_instance_address" {
  description = "Hostname of the RDS instance."
  value       = aws_db_instance.main.address
}

output "db_instance_arn" {
  description = "ARN of the RDS instance."
  value       = aws_db_instance.main.arn
}

output "rds_proxy_endpoint" {
  description = "Connection endpoint for the RDS Proxy."
  value       = aws_db_proxy.main.endpoint
}

output "rds_proxy_arn" {
  description = "ARN of the RDS Proxy."
  value       = aws_db_proxy.main.arn
}

output "security_group_id" {
  description = "Security group ID of the RDS instance."
  value       = aws_security_group.rds.id
}

output "proxy_security_group_id" {
  description = "Security group ID of the RDS Proxy."
  value       = aws_security_group.rds_proxy.id
}

output "secret_arns" {
  description = "Map of service name to Secrets Manager secret ARN for database credentials."
  value = {
    for name in local.service_names :
    name => aws_secretsmanager_secret.service_credentials[name].arn
  }
}

output "master_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the master password."
  value       = aws_secretsmanager_secret.master_password.arn
}
