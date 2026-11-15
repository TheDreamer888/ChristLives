resource "cloudflare_dns_record" "tunnel" {
  for_each = var.enable_dns_records ? var.hostname_to_tunnel_id : {}

  zone_id = var.zone_id
  name    = each.key
  type    = "CNAME"
  content = "${each.value}.${var.tunnel_target_suffix}"
  ttl     = 1
  proxied = var.proxy_enabled

  lifecycle {
    precondition {
      condition     = !contains(var.workflow_managed_hostnames, each.key)
      error_message = "This hostname is also managed by the existing DNS-sync workflow; choose one owner before proceeding."
    }
  }
}
