# Worker de NF em EC2 com Auto Scaling por profundidade da fila (aplicado na LocalStack via tflocal).
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  endpoints {
    ec2         = var.endpoint
    autoscaling = var.endpoint
    cloudwatch  = var.endpoint
    sqs         = var.endpoint
  }
}

variable "endpoint" {
  type    = string
  default = "http://localhost:4566"
}

# Auto Scaling é recurso Pro na LocalStack: na Community fica desligado
# (o autoscaling local é feito por scripts/autoscale-nf.sh). Na AWS real: -var enable_autoscaling=true
variable "enable_autoscaling" {
  type    = bool
  default = false
}

resource "aws_launch_template" "nf_worker" {
  name_prefix   = "cm-nf-worker-"
  image_id      = "ami-df5de72bdb3b" # AMI fake da LocalStack
  instance_type = "t3.small"
  user_data = base64encode(<<-EOT
    #!/bin/bash
    docker run -d --restart always -e SERVICE=nf-worker -e AWS_ENDPOINT=${var.endpoint} cm-node:local
  EOT
  )
}

resource "aws_autoscaling_group" "nf_worker" {
  count                     = var.enable_autoscaling ? 1 : 0
  name                      = "cm-nf-worker-asg"
  min_size                  = 2 # redundância mínima
  max_size                  = 6
  desired_capacity          = 2
  availability_zones        = ["us-east-1a", "us-east-1b"] # multi-AZ
  health_check_type         = "EC2"
  health_check_grace_period = 60
  launch_template {
    id      = aws_launch_template.nf_worker.id
    version = "$Latest"
  }
}

resource "aws_autoscaling_policy" "scale_out" {
  count                  = var.enable_autoscaling ? 1 : 0
  name                   = "nf-scale-out"
  autoscaling_group_name = aws_autoscaling_group.nf_worker[0].name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = 1
  cooldown               = 60
}

resource "aws_autoscaling_policy" "scale_in" {
  count                  = var.enable_autoscaling ? 1 : 0
  name                   = "nf-scale-in"
  autoscaling_group_name = aws_autoscaling_group.nf_worker[0].name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = -1
  cooldown               = 120
}

resource "aws_cloudwatch_metric_alarm" "queue_high" {
  alarm_name          = "cm-nf-queue-high"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = "cm-nf-q" }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = aws_autoscaling_policy.scale_out[*].arn
}

resource "aws_cloudwatch_metric_alarm" "queue_low" {
  alarm_name          = "cm-nf-queue-low"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = "cm-nf-q" }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "LessThanThreshold"
  alarm_actions       = aws_autoscaling_policy.scale_in[*].arn
}
