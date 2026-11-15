variable "enabled" {
  description = "Explicit opt-in; Azure is not provisioned in the approved phase-one preview."
  type        = bool
  default     = false
}

variable "subscription_id" {
  description = "Azure subscription ID, supplied only when the Azure stack is separately approved."
  type        = string
  default     = ""
}

variable "location" {
  description = "Candidate Azure EU region; confirm service availability and subscription policy before use."
  type        = string
  default     = "westeurope"
}

variable "name_prefix" {
  description = "Short lowercase alphanumeric prefix for Azure resources."
  type        = string
  default     = "aegis"
}

variable "name_suffix" {
  description = "Globally unique lowercase alphanumeric suffix for Azure resource names."
  type        = string
  default     = "preview"
}

variable "api_image" {
  description = "Reviewed container image URI for the stateless API."
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}

variable "api_port" {
  description = "Container port exposed by the API."
  type        = number
  default     = 8000
}

variable "min_replicas" {
  description = "Minimum replicas; zero is suitable only for a cost-focused preview."
  type        = number
  default     = 0
}

variable "max_replicas" {
  description = "Maximum replicas for the optional Azure API."
  type        = number
  default     = 2
}

variable "tags" {
  description = "Additional Azure resource tags."
  type        = map(string)
  default     = {}
}

