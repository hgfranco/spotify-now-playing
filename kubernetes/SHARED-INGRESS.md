# Shared ALB routing

This existing Ingress owns one ALB and routes both Spotify hostnames to the
Spotify Service and henryfranco.dev to the personal-site Service. The name,
namespace, class and implicit group stay the same.

Apply only after henryfranco-dev is Ready in spotify-now-playing and its ACM
certificate has been issued in us-east-1. The controller discovers ACM
certificates by the three TLS/rule hostnames; no certificate key is stored in
Kubernetes and no ARN placeholder needs editing.

The personal site's Service overrides the target-group healthcheck to /healthz.
Spotify keeps /api/status. Both Services use NodePort and instance targets.

Before applying, dry-run the manifest and confirm the three certificates exist.
After applying, verify both Spotify URLs still work. Test henryfranco.dev
directly against the ALB using curl --connect-to before enabling its Route 53
DNS cutover in Terraform. Keep the current site available until verified.

References:
- https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/cert_discovery/
- https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
