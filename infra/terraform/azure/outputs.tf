output "resource_group_name" {
  description = "Resource group created when the Azure stack is explicitly enabled."
  value       = var.enabled ? azurerm_resource_group.main[0].name : null
}

output "api_fqdn" {
  description = "Container App hostname when the Azure stack is explicitly enabled."
  value       = var.enabled ? azurerm_container_app.api[0].ingress[0].fqdn : null
}

