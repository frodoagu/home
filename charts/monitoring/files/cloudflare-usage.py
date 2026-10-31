"""Push what Cloudflare could bill into vmsingle (charts/monitoring cloudflareUsage).

Mounted raw by templates/cloudflare-usage.yaml: not Helm-templated.
"""
import datetime
import json
import os
import time
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]

# https://developers.cloudflare.com/r2/pricing/
CLASS_A = {
    "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
    "CompleteMultipartUpload", "CreateMultipartUpload",
    "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart",
    "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors",
    "PutBucketLifecycleConfiguration",
}
CLASS_B = {
    "HeadBucket", "HeadObject", "GetObject", "UsageSummary",
    "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
    "GetBucketLifecycleConfiguration",
}
FREE = {"DeleteObject", "DeleteBucket", "AbortMultipartUpload"}

QUERY = """
query ($account: string!, $day: Time!, $month: Time!, $now: Time!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      storage: r2StorageAdaptiveGroups(
        limit: 1000
        filter: {datetime_geq: $day, datetime_leq: $now}
        orderBy: [datetime_DESC]
      ) {
        max { payloadSize metadataSize objectCount }
        dimensions { bucketName datetime }
      }
      operations: r2OperationsAdaptiveGroups(
        limit: 1000
        filter: {datetime_geq: $month, datetime_leq: $now}
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}
"""


def call(path, body=None):
    request = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reply = json.load(response)
    if reply.get("errors"):
        raise SystemExit(f"{path}: {reply['errors']}")
    return reply


def label(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


now = datetime.datetime.now(datetime.timezone.utc)
month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
variables = {
    "account": ACCOUNT,
    "day": stamp(now - datetime.timedelta(days=1)),
    "month": stamp(month),
    "now": stamp(now),
}
account = call("/graphql", {"query": QUERY, "variables": variables})["data"]["viewer"]["accounts"][0]

lines = []
seen = set()
for row in account["storage"]:
    bucket = row["dimensions"]["bucketName"]
    if bucket in seen:
        continue  # newest first: the first row per bucket is its current size
    seen.add(bucket)
    size = row["max"]["payloadSize"] + row["max"]["metadataSize"]
    lines.append(f'cloudflare_r2_storage_bytes{{bucket="{label(bucket)}"}} {size}')
    lines.append(f'cloudflare_r2_objects{{bucket="{label(bucket)}"}} {row["max"]["objectCount"]}')

operations = {"A": 0, "B": 0, "free": 0, "other": 0}
for row in account["operations"]:
    action = row["dimensions"]["actionType"]
    kind = "A" if action in CLASS_A else "B" if action in CLASS_B else "free" if action in FREE else "other"
    operations[kind] += row["sum"]["requests"]
for kind, count in operations.items():
    lines.append(f'cloudflare_r2_operations_month{{class="{kind}"}} {count}')

for sub in call(f"/accounts/{ACCOUNT}/subscriptions")["result"]:
    if sub.get("state") in ("Cancelled", "Expired"):
        continue
    plan = (sub.get("rate_plan") or {}).get("public_name") or (sub.get("rate_plan") or {}).get("id") or sub.get("id")
    lines.append(
        f'cloudflare_subscription_price_usd{{plan="{label(plan)}",state="{label(sub.get("state", ""))}",'
        f'frequency="{label(sub.get("frequency", ""))}"}} {sub.get("price") or 0}'
    )

for zone in call(f"/zones?account.id={ACCOUNT}&per_page=50")["result"]:
    plan = zone.get("plan") or {}
    lines.append(
        f'cloudflare_zone_plan_price_usd{{zone="{label(zone["name"])}",plan="{label(plan.get("name", ""))}"}} '
        f'{plan.get("price") or 0}'
    )

lines.append(f"cloudflare_usage_last_success_timestamp_seconds {int(time.time())}")
body = ("\n".join(lines) + "\n").encode()
print(body.decode(), end="")
push = urllib.request.Request(os.environ["PUSH_URL"] + "?extra_label=job=cloudflare-usage", data=body)
urllib.request.urlopen(push, timeout=30).close()
