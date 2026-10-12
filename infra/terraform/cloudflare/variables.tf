variable "enable_dns_records" {
  description = "Explicit opt-in to create DNS records after reviewing hostname ownership."
  type        = bool
  default     = false
}

variable "zone_id" {
  description = "Cloudflare zone identifier."
  type        = string
  default     = ""
}

variable "hostname_to_tunnel_id" {
  description = "Map of hostnames to pre-created Cloudflare Tunnel UUIDs."
  type        = map(string)
  default     = {}
}

variable "workflow_managed_hostnames" {
  description = "Hostnames already managed by the repository's DNS-sync workflow."
  type        = set(string)
  default     = []
}

variable "proxy_enabled" {
  description = "Enable Cloudflare proxy for these records; verify residency and caching first."
  type        = bool
  default     = false
}

variable "tunnel_target_suffix" {
  description = "Cloudflare Tunnel DNS target suffix."
  type        = string
  default     = "cfargotunnel.com"
}

variable "account_id" {
  description = "Cloudflare account ID, reserved for future account-scoped resources."
  type        = string
  default     = ""
}

variable "region" {
  description = "EU region used for the shared Terraform S3 state backend configuration."
  type        = string
  default     = "eu-west-1"
}

variable "state_bucket_name" {
  description = "Existing private, versioned, encrypted S3 bucket used for remote state."
  type        = string
  default     = ""
}

