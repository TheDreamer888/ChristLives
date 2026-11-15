# Aegis Multi-Cloud Infrastructure Plan

> **Status:** Ready for Validation — IaC generation completed; pending validation step. No cloud resources will be created by this plan.
>
> Prepared: 2026-10-10

## 1. Goal and scope

Prepare Terraform infrastructure for Aegis with **AWS as the primary cloud**, **Cloudflare for DNS/edge where its data-localization limits permit**, and **Azure as an optional secondary-cloud foundation**. The first deployment target is a low-cost development/preview environment serving Portugal from within the EU. Design future regional expansion without deploying those regions now.

This request is for infrastructure as code only. It does not change application behavior, integrate an AI provider or WHO/Harvard data API in application code, or redesign the frontend. The user's "Tesla-like" direction is interpreted as a fast, polished, globally extensible platform; the visual redesign remains outside this IaC scope.

## 2. Confirmed requirements and constraints

| Attribute | Decision |
|---|---|
| Project | Existing Aegis monorepo; modernize/extend its cloud infrastructure |
| Environment | Development/preview, not production |
| Scale | Medium eventual ambition (1,000–100,000 users); preview resources must be deliberately small |
| Budget | Target of at most €100/month for the initial preview; **a target, not a price guarantee** |
| Primary cloud | AWS |
| AWS region, phase 1 | Europe (Ireland), `eu-west-1` |
| Secondary cloud | Azure, represented as an opt-in Terraform module; disabled and unprovisioned in phase 1 |
| Azure candidate region | West Europe (Netherlands), subject to service availability, subscription policy, and user confirmation before activation |
| Edge/DNS | Cloudflare |
| Data residency | Keep phase-1 application data in the EU; minimize personal/sensitive data and do not replicate it to future regions by default |
| Resilience | Do not deploy active multi-region/high-availability infrastructure in the preview phase; define a later regional-cell expansion path |
| Preview availability trade-off | User accepts one AWS host, a single point of failure, and no autoscaling for the preview |
| Legal scope | Plan for jurisdiction-specific privacy, consumer, AI, sanctions/export, and copyright review before enabling each future country |
| Deployment | IaC preparation only. No `terraform apply`, Azure deployment, account login, DNS mutation, or paid-resource provisioning is authorized |
| Accounts | Azure subscription listing could not be read because Azure credentials are unavailable. No AWS account or Cloudflare credentials were provided or inspected |

The user mentioned the EU/Portugal, United States, Brazil, China, Russia, Ukraine, Israel, India, and the Netherlands. **Only the EU/Ireland preview is in phase-1 deployment scope.** Other jurisdictions are future design considerations, not approved deployment regions.

## 3. Existing workspace components

| Component | Technology | Path | Notes |
|---|---|---|---|
| Frontend | React 19, Vite, TypeScript, Nginx container | `apps/frontend` | Static/public assets can be separated from personalized/authenticated traffic |
| Main API | FastAPI, Python, PostgreSQL, Redis | `services/api-python` | Includes authentication, assistant, agency, DNS, and protection routes |
| Auxiliary API | Axum, Rust | `services/api-rust` | Keep deployable as a separate service; do not assume feature parity |
| Auxiliary API | ASP.NET, .NET 10 | `services/api-dotnet/WebApplication1` | Keep deployable as a separate service; do not assume feature parity |
| Local orchestration | Docker Compose | `docker-compose.yml` | Preserve localhost-only development bindings |
| Existing Azure IaC | Bicep | `infra/azure/main.bicep` | Existing user-authored work; do not overwrite or remove as part of this plan |
| Existing CI | GitHub Actions, including Azure workflow | `.github/workflows` | Preserve existing workflows unless a separately approved implementation requires a surgical change |

The worktree already contains numerous user changes. Any implementation must preserve them and avoid unrelated files.

## 4. Proposed IaC approach

**Selected:** Terraform with separate AWS, Azure, and Cloudflare stacks and small, composable modules.

**Rationale:** AWS is primary, but the user explicitly requested AWS, Azure, and Cloudflare. Terraform supports this multi-provider scope without converting or deleting the existing Azure Bicep files. Keep provider stacks separate so an AWS plan/apply cannot accidentally create Azure resources or alter Cloudflare DNS. AWS is the initial apply target; Azure resources are opt-in and Cloudflare changes require explicit credentials and a reviewed plan.

Terraform remote state should reside in a dedicated, encrypted, versioned, private AWS S3 backend in `eu-west-1`, protected by least-privilege access and native state locking. Backend bootstrap is a separate, explicitly reviewed step; no state bucket is created during planning.

## 5. Target architecture

### Phase 1: EU development/preview

| Concern | Proposed resource/pattern | Guardrail |
|---|---|---|
| API and services | One small AWS EC2 host in `eu-west-1`, running the existing Docker Compose stack | User-approved preview trade-off: single point of failure, no autoscaling, and operational responsibility for the host |
| Database and cache | PostgreSQL and Redis containers on encrypted persistent EBS storage on the same host | Preview only; backups must be EU-local and restore-tested; no cross-region personal-data replication |
| Network entry | Cloudflare Tunnel from the host to Cloudflare; no inbound SSH or application ports in the host security group | Create the tunnel and its token outside Terraform, then inject its token out-of-band from AWS Systems Manager Parameter Store SecureString; never put its value in Terraform state |
| Host administration | EC2 instance profile, Systems Manager Session Manager, IMDSv2, and least privilege | Do not expose SSH publicly; patch the host and pin container images |
| Secrets and encryption | AWS-managed KMS key for Parameter Store SecureString; encrypted EBS | Terraform manages secret names/access policy only; secret values are entered separately after provisioning |
| Frontend and API | Existing frontend/API containers behind explicitly configured Cloudflare Tunnel hostnames | Do not cache authenticated, personalized, or sensitive responses |
| DNS and TLS | Cloudflare DNS records in a dedicated Cloudflare stack, pointing to a pre-created tunnel | Existing GitHub DNS-sync workflow also changes records; resolve ownership before enabling either writer for the same record |
| CI/CD | GitHub Actions OIDC to a narrowly scoped AWS role, with an environment approval before apply | No long-lived cloud access keys |
| Telemetry | Regional AWS logs/metrics and alarms with short, explicit retention | Exclude credentials, prompts, tokens, health data, and request bodies from logs by default |
| Cost controls | AWS Budget alerts, tags, and host/storage ceilings | Alerts do not stop spend; deployment remains blocked until the price estimate is reviewed |

This phase is a preview, **not** a highly available or production-certified system. A €100 monthly limit cannot be guaranteed without an account-specific price calculation, traffic assumptions, exact instance/storage sizes, data transfer, backup/log volume, and Cloudflare plan details. Prefer omitting optional services over silently exceeding the target.

### Azure secondary foundation

Provide an Azure stack as **IaC only**; do not create Azure resources in phase 1. If later activated, West Europe is the candidate region, with a separately reviewed Azure subscription, policy, quota, price, and data-flow check. Do not copy AWS preview data into Azure by default; failover requires an explicit recovery and residency decision. Azure credentials were unavailable during planning, so subscription and policy constraints remain unverified.

### Cloudflare and global expansion

Use Cloudflare DNS initially. Do not proxy API/authenticated or sensitive-data traffic through Cloudflare until the account's products, contract, processing locations, logs, and retention are verified against the required residency policy. Cloudflare's Data Localization Suite and regional processing capabilities must not be assumed available within the €100/month target.

Future geographic expansion should use isolated regional cells: region-local compute, storage, encryption keys, logs, and secrets; explicit user/data routing; no cross-region personal-data replication by default. Public static assets may use global delivery only after confirming they contain no personal or licensed/restricted content.

Country-specific constraints are not a single Terraform switch. China may require a distinct cloud partition/account and local operating arrangements; AWS has no AWS Region in Russia. Do not represent this design as providing Russian data residency or as satisfying any country's laws. Each new market needs current legal, provider-availability, sanctions/export-control, and data-transfer review.

## 6. AI, trusted sources, empathy, and copyright boundaries

- This phase provisions no AI API integration or model access. A future application change may evaluate an EU-region inference endpoint and require explicit confirmation of provider/model, terms, data-use settings, cost, and availability.
- Treat health, identity, authentication, and user-submitted content as sensitive: minimize what is sent to external providers; do not log prompts or responses; do not use user content for model training unless separately and explicitly authorized.
- A future knowledge connector may use only official, authorized WHO and Harvard endpoints or datasets whose terms permit the intended use. There is no assumed universal "Harvard API" or permission to scrape restricted pages.
- Store source attribution, links, publication/version dates, and license/terms metadata. Do not reproduce copyrighted text beyond the applicable license or permitted quotation; obtain rights-holder permission when required.
- Any assistant guidance should be transparent, empathetic, non-coercive, and clear that it is not medical, legal, or pastoral authority. It may reflect user-requested values such as compassion and teachings attributed to Jesus without claiming to speak for a church, the WHO, or Harvard.

## 7. Capacity, quota, and cost gates

| Platform | Phase-1 planned deployment quantity | Capacity/price status |
|---|---:|---|
| AWS, `eu-west-1` | One preview host, one encrypted data volume, one tunnel; exact size and retention gated on account-specific plan | Not queried; no AWS account context was supplied. Check service quotas and calculate current prices before apply |
| Azure, West Europe | Zero resources; provider/module disabled | Azure subscription unavailable and no Azure resources will be deployed in phase 1; quota check is not applicable until Azure is enabled |
| Cloudflare | No DNS mutation during preparation | Plan, account entitlements, and domain/zone identifiers not supplied; verify before any DNS or localization change |

**Cost gate:** Before execution, produce an account- and SKU-specific estimate (including database, compute, storage, networking/NAT, logging, backups, AI usage if later approved, and Cloudflare plan). If the forecast exceeds €100/month, stop and present lower-cost alternatives for approval; do not deploy automatically.

## 8. Security, privacy, and operations

- Encrypt data in transit and at rest; keep databases and administrative interfaces private.
- Use least-privilege workload roles and GitHub OIDC. Never place cloud credentials or provider secrets in code, committed `.tfvars`, frontend variables, or logs.
- Separate state and environments; protect and encrypt Terraform state because it can contain sensitive metadata.
- Apply region/environment/owner/data-classification tags where supported.
- Define retention and deletion behavior for application data, backups, logs, and external-source caches before production.
- Keep Cloudflare DNS, WAF/proxy, caching, and localization choices explicit per hostname; do not imply that DNS-only mode supplies WAF or CDN protection.
- Preserve the repository's existing security posture and local Docker Compose behavior.

## 9. Validation and approval gates

1. After approval, add IaC without overwriting existing Azure Bicep or unrelated dirty worktree files.
2. Run formatting, initialization, static validation, and security/IaC checks without applying resources.
3. Review the complete Terraform plan for every provider and verify disabled providers/resources are not created.
4. Confirm AWS identity, region, service quotas, and a cost estimate before any AWS apply.
5. If Azure is enabled, obtain the subscription and region confirmation, inspect Azure Policy assignments, check availability/quotas, and estimate cost before Azure apply.
6. If Cloudflare changes are enabled, review the exact zone, records, proxy mode, and localization contract before mutation.
7. Deployment is a separate user-approved action; this plan does not authorize it.

## 10. Approval

**Approved:** IaC generation and validation only. AWS/Cloudflare preview scope as described above; no deploy or resource provisioning.

Approval will authorize IaC preparation only, not cloud deployment, account login, DNS edits, or paid-resource creation.
