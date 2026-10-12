data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_vpc" "preview" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.application}-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "preview" {
  vpc_id = aws_vpc.preview.id

  tags = {
    Name = "${var.application}-${var.environment}-igw"
  }
}

resource "aws_subnet" "preview" {
  vpc_id                  = aws_vpc.preview.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.application}-${var.environment}-subnet"
  }
}

resource "aws_route_table" "preview" {
  vpc_id = aws_vpc.preview.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.preview.id
  }

  tags = {
    Name = "${var.application}-${var.environment}-routes"
  }
}

resource "aws_route_table_association" "preview" {
  subnet_id      = aws_subnet.preview.id
  route_table_id = aws_route_table.preview.id
}

resource "aws_security_group" "host" {
  name_prefix = "${var.application}-${var.environment}-"
  description = "No inbound access; administration and application entry use outbound services."
  vpc_id      = aws_vpc.preview.id

  egress {
    description = "Required for Session Manager, updates, image pulls, and outbound APIs."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.application}-${var.environment}-host"
  }
}

resource "aws_iam_role" "host" {
  name = "${var.application}-${var.environment}-host"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "session_manager" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "tunnel_token" {
  count = var.enable_cloudflare_tunnel ? 1 : 0

  name = "${var.application}-${var.environment}-tunnel-token"
  role = aws_iam_role.host.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlyConfiguredTunnelToken"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.cloudflare_tunnel_token_parameter_name}"
      },
      {
        Sid      = "DecryptOnlyThroughRegionalParameterStore"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.region}.${data.aws_partition.current.dns_suffix}"
          }
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.application}-${var.environment}-host"
  role = aws_iam_role.host.name
}

resource "aws_instance" "host" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.preview.id
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true
  monitoring                  = false
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    enable_cloudflare_tunnel             = var.enable_cloudflare_tunnel
    cloudflare_tunnel_token_parameter_name = var.cloudflare_tunnel_token_parameter_name
    cloudflared_image                    = var.cloudflared_image
    region                               = var.region
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    encrypted             = true
    delete_on_termination = false
  }

  disable_api_termination = true

  depends_on = [aws_route_table_association.preview]

  tags = {
    Name = "${var.application}-${var.environment}-host"
  }
}

resource "aws_budgets_budget" "monthly" {
  count = var.budget_alert_email == "" ? 0 : 1

  name         = "${var.application}-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
