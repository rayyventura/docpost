output "queue_urls" {
  description = "Map of queue name to SQS queue URL."
  value = {
    for name, queue in aws_sqs_queue.main :
    name => queue.url
  }
}

output "queue_arns" {
  description = "Map of queue name to SQS queue ARN."
  value = {
    for name, queue in aws_sqs_queue.main :
    name => queue.arn
  }
}

output "dlq_urls" {
  description = "Map of queue name to dead letter queue URL."
  value = {
    for name, queue in aws_sqs_queue.dlq :
    name => queue.url
  }
}

output "dlq_arns" {
  description = "Map of queue name to dead letter queue ARN."
  value = {
    for name, queue in aws_sqs_queue.dlq :
    name => queue.arn
  }
}
