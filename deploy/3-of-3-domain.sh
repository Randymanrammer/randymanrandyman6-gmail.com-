# INSTANT ONLINE SUCCESS - Cloud Shell script 3 of 3 (success-domain.com + HTTPS + CDN + backups + budget)
# Run once to create everything and get your DNS records. Run again after adding them: it turns the domain on.
set -e
P=$(gcloud config get-value project 2>/dev/null); R=us-central1; S=instant-online-success; D=success-domain.com
gcloud services enable compute.googleapis.com certificatemanager.googleapis.com billingbudgets.googleapis.com >/dev/null
ok(){ "$@" >/dev/null 2>&1; }
ok gcloud compute addresses describe ios-ip --global || gcloud compute addresses create ios-ip --global
IP=$(gcloud compute addresses describe ios-ip --global --format='value(address)')
ok gcloud certificate-manager dns-authorizations describe ios-dns || gcloud certificate-manager dns-authorizations create ios-dns --domain=$D
ok gcloud certificate-manager certificates describe ios-cert || gcloud certificate-manager certificates create ios-cert --domains="$D,*.$D" --dns-authorizations=ios-dns
ok gcloud certificate-manager maps describe ios-map || gcloud certificate-manager maps create ios-map
ok gcloud certificate-manager maps entries describe ios-root --map=ios-map || gcloud certificate-manager maps entries create ios-root --map=ios-map --certificates=ios-cert --hostname=$D
ok gcloud certificate-manager maps entries describe ios-wild --map=ios-map || gcloud certificate-manager maps entries create ios-wild --map=ios-map --certificates=ios-cert --hostname="*.$D"
ok gcloud compute network-endpoint-groups describe ios-neg --region=$R || gcloud compute network-endpoint-groups create ios-neg --region=$R --network-endpoint-type=serverless --cloud-run-service=$S
if ! ok gcloud compute backend-services describe ios-be --global; then
  gcloud compute backend-services create ios-be --global --load-balancing-scheme=EXTERNAL_MANAGED --enable-cdn --cache-mode=USE_ORIGIN_HEADERS
  gcloud compute backend-services add-backend ios-be --global --network-endpoint-group=ios-neg --network-endpoint-group-region=$R
fi
ok gcloud compute url-maps describe ios-um --global || gcloud compute url-maps create ios-um --default-service=ios-be --global
ok gcloud compute target-https-proxies describe ios-hp --global || gcloud compute target-https-proxies create ios-hp --url-map=ios-um --certificate-map=ios-map --global
ok gcloud compute forwarding-rules describe ios-fr --global || gcloud compute forwarding-rules create ios-fr --global --load-balancing-scheme=EXTERNAL_MANAGED --address=ios-ip --target-https-proxy=ios-hp --ports=443
if ! ok gcloud compute url-maps describe ios-redir --global; then
  printf 'name: ios-redir\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n' > /tmp/ios-redir.yaml
  gcloud compute url-maps import ios-redir --global --source=/tmp/ios-redir.yaml --quiet
  gcloud compute target-http-proxies create ios-httpp --url-map=ios-redir --global
  gcloud compute forwarding-rules create ios-fr80 --global --load-balancing-scheme=EXTERNAL_MANAGED --address=ios-ip --target-http-proxy=ios-httpp --ports=80
fi
ok gcloud firestore backups schedules list --database="(default)" --format='value(name)' | grep -q . || gcloud firestore backups schedules create --database="(default)" --recurrence=daily --retention=4w || true
BA=$(gcloud billing projects describe $P --format='value(billingAccountName)' | sed 's|billingAccounts/||')
if [ -n "$BA" ] && ! gcloud billing budgets list --billing-account=$BA --format='value(displayName)' 2>/dev/null | grep -q '^ios-monthly$'; then
  read -rp "Monthly Google Cloud budget in USD for email alerts (Enter = 100): " BUD; BUD=${BUD:-100}
  gcloud billing budgets create --billing-account=$BA --display-name=ios-monthly --budget-amount=${BUD}USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
fi
gcloud run services update $S --region $R --update-env-vars LB_IP=$IP,CERT_MAP=ios-map --quiet >/dev/null
STATE=$(gcloud certificate-manager certificates describe ios-cert --format='value(managed.state)')
if [ "$STATE" = ACTIVE ]; then
  gcloud run services update $S --region $R --update-env-vars SUBDOMAINS_LIVE=yes,BASE_URL=https://$D --quiet >/dev/null
  echo "DONE 3 of 3. LIVE: https://$D and https://[site-name].$D  (custom domains now on)"
else
  echo "Add these 3 DNS records where you bought $D, then run this script again in an hour:"
  echo "  A      @   $IP"
  echo "  A      *   $IP"
  gcloud certificate-manager dns-authorizations describe ios-dns --format='value[separator="   "](dnsResourceRecord.type,dnsResourceRecord.name,dnsResourceRecord.data)' | sed 's/^/  /'
  echo "HTTPS certificate: $STATE (it turns ACTIVE after the records work)"
fi
