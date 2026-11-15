locals {
  resource_group_name = "${var.name_prefix}-${var.name_suffix}-rg"
  workspace_name      = "${var.name_prefix}-${var.name_suffix}-law"
  environment_name    = "${var.name_prefix}-${var.name_suffix}-cae"
  container_app_name  = "${var.name_prefix}-${var.name_suffix}-api"
  common_tags = merge(var.tags, {
    application = var.name_prefix
    environment = var.name_suffix
    managed_by  = "terraform"
  })
}

resource "azurerm_resource_group" "main" {
  count = var.enabled ? 1 : 0

  name     = local.resource_group_name
  location = var.location
  tags     = local.common_tags
}

resource "azurerm_log_analytics_workspace" "main" {
  count = var.enabled ? 1 : 0

  name                = local.workspace_name
  location            = var.location
  resource_group_name = azurerm_resource_group.main[0].name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_container_app_environment" "main" {
  count = var.enabled ? 1 : 0

  name                       = local.environment_name
  location                   = var.location
  resource_group_name        = azurerm_resource_group.main[0].name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main[0].id
  log_analytics_workspace_key = azurerm_log_analytics_workspace.main[0].primary_shared_key
  tags                       = local.common_tags
}

resource "azurerm_container_app" "api" {
  count = var.enabled ? 1 : 0

  name                         = local.container_app_name
  container_app_environment_id = azurerm_container_app_environment.main[0].id
  resource_group_name          = azurerm_resource_group.main[0].name
  revision_mode                = "Single"
  tags                         = local.common_tags

  identity {
    type = "SystemAssigned"
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "api"
      image  = var.api_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "ENV"
        value = "preview"
      }
    }
  }

  ingress {
    external_enabled           = true
    target_port                 = var.api_port
    transport                   = "auto"
    allow_insecure_connections  = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}
