output "managed_hostnames" {
  description = "Hostnames whose CNAME records Terraform manages."
  value       = keys(cloudflare_dns_record.tunnel)
}

