# Application manifests

This directory owns the Spotify Deployment, Service, ConfigMap, NetworkPolicy and PVC.

Shared routing and the cluster-wide `ebs-gp3` StorageClass are managed in [hgfranco/k8s-infra](https://github.com/hgfranco/k8s-infra/tree/main/clusters/kubernetes). Terraform owns AWS/DNS/certificates; Ansible provisions the cluster and controllers.

## Source migration

Merge the k8s-infra infrastructure PR before this cleanup. The removed Ingress and StorageClass files remain live in Kubernetes. **Do not delete or prune them**, and do not delete the PVC or EBS volume. Applying this directory does not remove resources whose source files were moved.

For a new cluster, create the `spotify-now-playing` namespace and apply the shared StorageClass before applying this application's PVC. Install the application Secret using the existing secret synchronization process; never commit its values.

The PVC uses WaitForFirstConsumer, so it can remain Pending until a consuming Pod is scheduled.

```bash
kubectl apply --dry-run=server -f kubernetes/
kubectl apply -f kubernetes/
kubectl rollout status deployment/spotify-now-playing -n spotify-now-playing --timeout=120s
```

Apply shared Ingress changes from k8s-infra after the required Services and certificates are ready. Merging either repository's PR does not deploy automatically.
