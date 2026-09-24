output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.main.arn
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = aws_lb.main.dns_name
}

output "listener_arn" {
  description = "ARN of the HTTP listener."
  value       = aws_lb_listener.http.arn
}

output "security_group_id" {
  description = "Security group ID of the ALB."
  value       = aws_security_group.alb.id
}

output "target_group_arns" {
  description = "Map of service name to target group ARN."
  value = {
    for name, tg in aws_lb_target_group.services :
    name => tg.arn
  }
}
