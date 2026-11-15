output "instance_id" {
  description = "Instance ID for Session Manager administration."
  value       = aws_instance.host.id
}

output "private_ip" {
  description = "Private address of the single preview host."
  value       = aws_instance.host.private_ip
}

output "session_manager_command" {
  description = "AWS CLI command to start an inbound-free Session Manager session."
  value       = "aws ssm start-session --target ${aws_instance.host.id} --region ${var.region}"
}

output "cloudflare_tunnel_token_parameter_name" {
  description = "SSM parameter path expected by the optional Tunnel service; contains no secret."
  value       = var.enable_cloudflare_tunnel ? var.cloudflare_tunnel_token_parameter_name : null
}

