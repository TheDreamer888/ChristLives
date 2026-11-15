# Terraform multi-cloud foundation

This directory keeps each provider in its own stack so an AWS operation cannot
accidentally change Azure resources or Cloudflare DNS. `infra/azure/` remains the
existing Bicep stack and is not replaced by these files.

## Phase-one scope

- `aws/`: one development EC2 host in `eu-west-1`, with no inbound security-group
  rules, Systems Manager access, encrypted root storage, and an optional Cloudflare
  Tunnel service. This is a single point of failure, not production HA.
- `cloudflare/`: optional CNAME records for a tunnel that has been created outside
  Terraform. DNS management is disabled until explicitly enabled and reviewed.
- `azure/`: optional Azure Container Apps foundation in West Europe. It is disabled
  by default and has no database or cross-cloud data replication.

The preview is intended to stay near, not guaranteed below, €100/month. Choose
smaller/larger instance sizes only after checking the account-specific AWS
calculator estimate, including data transfer, backups, logs, and tax. The AWS
Budget alert is optional and is an alert, not a spending cap.

## Safe checks (no deployment)

Run from each stack directory:

```powershell
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

No `terraform plan` or `terraform apply` is part of this approved task. Do not
commit generated `.tfvars`, state, plan files, credentials, or provider tokens.

## AWS

The host uses Amazon Linux 2023, IMDSv2, an EC2 instance profile, and Session
Manager; it has no public SSH or application ingress. Outbound access is required
for package/image downloads and Session Manager. Docker is installed, but this
stack does not build/publish application images or run `docker compose up`.

If enabling the tunnel, first create a Cloudflare Tunnel in the Cloudflare
dashboard and store its token out-of-band as an AWS Systems Manager
Parameter Store `SecureString` at the configured parameter path. Terraform only
stores the parameter name and grants the instance access; the token value is
never passed through Terraform. Select a reviewed, pinned `cloudflared` image
tag before enabling it.

Terraform's S3 backend is partial by design. Before planning or applying, bootstrap
a private, versioned, encrypted S3 state bucket in the EU, enable native S3 state
locking, and supply backend configuration out-of-band. Do not use a local state
file for real infrastructure.

## Cloudflare

The provider reads `CLOUDFLARE_API_TOKEN` from the environment. Configure only a
scoped token with the required DNS permissions. Set the account/zone and tunnel
hostname inputs, inspect the plan, and set `enable_dns_records = true` explicitly.

The repository already has `.github/workflows/cloudflare-dns.yml`. Ensure that no
hostname is written by both that workflow and Terraform. Do not enable proxying
for authenticated or sensitive API routes until the Cloudflare contract,
processing region, logging, and retention meet the residency policy. Cloudflare
Tunnel creation and its token remain outside Terraform to keep token material out
of Terraform state.

## Azure

The separate Azure stack is disabled by default. A future operator must supply a
subscription, confirm the region, inspect Azure Policy and quotas, and review
service availability and cost before enabling it. It must not be treated as an
automatic failover target or receive user data until data routing and recovery
behavior are explicitly designed and approved.

## Future global expansion

Add isolated regional cells only after a jurisdiction-specific legal and provider
availability review. Keep identity, user data, keys, logs, and backups in each
approved residency boundary by default. China requires separate provider/account
arrangements; AWS does not provide an AWS Region in Russia. This IaC does not
claim compliance with any jurisdiction.

AI provider/API integration, WHO/Harvard content ingestion, application behavior,
copyright/licensing approval, and frontend redesign are outside this infrastructure
task.
