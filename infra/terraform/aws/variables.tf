variable "application" {
  description = "Short application identifier used in resource names and tags."
  type        = string
  default     = "aegis"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "preview"
}

variable "region" {
  description = "AWS region for the initial EU preview."
  type        = string
  default     = "eu-west-1"
}

variable "vpc_cidr" {
  description = "IPv4 address range for the isolated preview VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "subnet_cidr" {
  description = "IPv4 address range for the single public subnet."
  type        = string
  default     = "10.40.1.0/24"
}

variable "instance_type" {
  description = "EC2 size for the single-host preview; estimate cost before changing."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gib" {
  description = "Encrypted persistent root volume size for the Docker host."
  type        = number
  default     = 50

  validation {
    condition     = var.root_volume_size_gib >= 30 && var.root_volume_size_gib <= 200
    error_message = "root_volume_size_gib must be between 30 and 200 GiB."
  }
}

variable "enable_cloudflare_tunnel" {
  description = "Install a cloudflared service that reads its token from SSM at runtime."
  type        = bool
  default     = false
}

variable "cloudflare_tunnel_token_parameter_name" {
  description = "Existing SSM SecureString path containing the tunnel token; never its value."
  type        = string
  default     = "/aegis/preview/cloudflare-tunnel-token"
}

variable "cloudflared_image" {
  description = "Reviewed and pinned Cloudflare Tunnel container image."
  type        = string
  default     = "cloudflare/cloudflared:latest"
}

variable "budget_alert_email" {
  description = "Optional email recipient for the AWS monthly budget alert."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Approximate USD equivalent for the monthly €100 target; update for FX/tax."
  type        = number
  default     = 110
}

