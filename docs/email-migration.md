# Email — self-hosting `fede@agu.com.ar` off Google Workspace

Design + migration runbook for moving the primary mailbox off **Google Workspace
Business Starter** (~$7/user/mo) to a self-hosted mail server on the existing
k3s/Raspberry Pi, GitOps-managed like every other service here.

## Why

- **Cost.** Business Starter is ~$72–84/yr for one user. The Pi is already a sunk
  cost running 24/7, so the marginal spend of self-hosting is an outbound relay
  (pennies/mo) + backup storage (~$1/mo). Net saving ~$70/yr.
- **Control.** One mailbox + aliases on `agu.com.ar`, fully owned.
- **The only Google dependency to unwind is "Sign in with Google"** on this
  address (no reliance on Calendar/Drive/Photos) — handled in the runbook below.

The price is paid in **risk and attention**, not dollars: this address recovers
all your other accounts, so its uptime and backups are now your problem. Mitigated
by the relay (deliverability), sender retries (inbound outages), and offsite
backups + an external recovery address (data loss). Eyes open.

## Design decisions

| Question | Choice | Why |
|---|---|---|
| Where it runs | **Pi (this cluster)** | Already on 24/7; port 25 inbound **confirmed open**. |
| Outbound | **Relay via AWS SES** | Kills the residential-IP problem: SES owns the IP reputation + rDNS. ~$0.10/1k emails ≈ $0/mo at personal volume. |
| Inbound | **Direct to the Pi on :25** | Receiving doesn't care about rDNS/IP reputation; senders retry for days on a blip. |
| Server software | **Stalwart** | Single Rust binary (SMTP+IMAP+JMAP), built-in antispam + ACME, low RAM — ideal for arm64/Pi. Lighter than docker-mailserver (Postfix/Dovecot/Rspamd). |
| Webmail | **SnappyMail** (lean) / Roundcube (familiar) | Standard IMAP webmail at `webmail.agu.com.ar`. SnappyMail is lighter for the Pi. |
| Phone | **Standard IMAP/SMTP** | Works with iOS Mail, Android (FairEmail/Thunderbird for instant push), etc. |
| Mailbox count | **1 real mailbox + aliases** | Aliases are free routing rules in Stalwart. |

## Architecture

The trick is to **split the two directions** — they have opposite requirements.

```
OUTBOUND   phone / webmail / clients
             │  (authenticated submission :587/:465)
             ▼
           Stalwart (Pi)  ──smarthost──▶  AWS SES  ──▶  recipients
             reputable IP + PTR + DKIM live on SES, never on the home line.

INBOUND    senders ──▶ MX: mail.agu.com.ar ──▶ Cloudflare DNS (grey) ──▶ home IP
                                                                          │ :25
                                                                          ▼
                                                              Stalwart (Pi) ── IMAP store (SSD PV)
             rDNS / IP reputation irrelevant for receiving; retries cover brief downtime.

WEBMAIL    browser ──▶ webmail.agu.com.ar ──▶ Traefik IngressRoute ──▶ SnappyMail
                                                                          │ IMAP/SMTP (in-cluster)
                                                                          ▼
                                                                       Stalwart
```

### Components (new chart `charts/mailserver/`, app `apps/mailserver.yaml`)

| Piece | Role |
|---|---|
| **Stalwart** | SMTP (25 inbound, 465/587 submission), IMAP (993), JMAP; antispam; aliases; mailbox store on a persistent volume. Relays all outbound through SES. |
| **SnappyMail** (or Roundcube) | Webmail UI at `webmail.agu.com.ar`; talks to Stalwart over IMAP/SMTP inside the cluster. |
| **restic backup** (CronJob) | Mail store + Stalwart config → Backblaze B2 (or S3). **Non-negotiable** for a primary mailbox. |

Follows the repo's chart conventions (see CLAUDE.md): `IngressRoute`
(`traefik.io/v1alpha1`, `entryPoints: [websecure]`, `tls.certResolver: letsencrypt`)
for the **webmail** HTTP host; mail ports (25/465/587/993) are raw TCP, **not** via
a Traefik HTTP IngressRoute (see TLS note below).

## DNS (Cloudflare)

Add the hostnames to [charts/cloudflare-ddns/values.yaml](../charts/cloudflare-ddns/values.yaml)
`domains:` (the DDNS updater creates/maintains the A records):

- `mail.agu.com.ar` — **must be DNS-only (grey cloud).** Cloudflare's proxy only
  fronts HTTP/S; proxying would break SMTP/IMAP and hide the real IP that inbound
  mail needs. favonia's `PROXIED` accepts a per-host predicate, so set it to e.g.
  `!is(mail.agu.com.ar)` (proxy everything *except* the mail host) instead of the
  current global `proxied: true`.
- `webmail.agu.com.ar` — HTTP, so proxied (orange) is fine.

Records to create (mostly one-time, in the Cloudflare zone):

| Record | Value | Notes |
|---|---|---|
| `MX agu.com.ar` | `mail.agu.com.ar` (prio 10) | inbound to the Pi |
| `A mail.agu.com.ar` | home public IP (via DDNS, **grey**) | dynamic |
| `TXT agu.com.ar` (SPF) | `v=spf1 include:amazonses.com -all` | authorize **SES**, not the home IP (outbound goes via SES) |
| DKIM (SES Easy DKIM) | 3× CNAME from SES | DMARC alignment |
| `TXT _dmarc` | `v=DMARC1; p=quarantine; rua=mailto:fede@agu.com.ar` | start at quarantine, tighten to `reject` later |
| (optional) MTA-STS / TLS-RPT | — | nice-to-have hardening |

## Secrets (committed as SealedSecrets)

This repo commits every secret as a **`SealedSecret`** (see [docs/secrets.md](secrets.md)) —
encrypted so only this cluster's controller can decrypt. Build each Secret
manifest **without applying it**, pipe through `kubeseal`, and commit the result
under `charts/mailserver/templates/`. The controller runs at
`kube-system/sealed-secrets-controller`, so **`kubeseal` needs no flags**. ArgoCD
syncs the SealedSecret with the chart (namespace `mailserver`, created via
`CreateNamespace=true`) and the controller unseals it into the real Secret.

```bash
# SES SMTP credentials (from an IAM user's SES SMTP creds)
kubectl create secret generic ses-smtp -n mailserver \
  --from-literal=username='<SES_SMTP_USER>' \
  --from-literal=password='<SES_SMTP_PASS>' --dry-run=client -o yaml \
| kubeseal --format yaml > charts/mailserver/templates/ses-smtp-sealed.yaml

# Cloudflare token for Stalwart's own ACME DNS-01. Same DNS:Edit token as
# cloudflare-ddns, but re-sealed here — seals are scoped to name+namespace.
kubectl create secret generic cloudflare-acme-token -n mailserver \
  --from-literal=CLOUDFLARE_API_TOKEN='<token>' --dry-run=client -o yaml \
| kubeseal --format yaml > charts/mailserver/templates/cloudflare-acme-token-sealed.yaml

# restic repo password + B2 keys for backups
kubectl create secret generic mail-backup -n mailserver \
  --from-literal=RESTIC_PASSWORD='<pw>' \
  --from-literal=B2_ACCOUNT_ID='...' --from-literal=B2_ACCOUNT_KEY='...' \
  --dry-run=client -o yaml \
| kubeseal --format yaml > charts/mailserver/templates/mail-backup-sealed.yaml
```

Match the repo convention on each generated file: add
`sealedsecrets.bitnami.com/managed: 'true'` under `spec.template.metadata.annotations`
(keeps a re-derived plain Secret adoptable in place — no downtime). Then add a row
per secret to the inventory table in [docs/secrets.md](secrets.md). The controller's
private key is already backed up off-repo per that doc — **don't lose it**, or these
sealed values become unrecoverable.

## TLS

- **Webmail** (`webmail.agu.com.ar`): normal Traefik IngressRoute with the
  `letsencrypt` certResolver — identical to every other service.
- **Mail ports** (993/465/587): Stalwart does **its own ACME via Cloudflare
  DNS-01** (the `cloudflare-acme-token` above), because Traefik's ACME store
  isn't readily shareable to a non-HTTP pod. A valid public cert is what lets the
  phone connect with no "untrusted certificate" warning.

## Storage & backups

- Mail store + Stalwart config on a **persistent volume backed by a USB SSD**, not
  the SD card (write durability + integrity).
- `restic` CronJob → **Backblaze B2** (~$1/mo). Test a restore before cancelling
  Google. Losing the mail store with no backup = unrecoverable history.

## Webmail

`webmail.agu.com.ar`, **not** behind the `google-auth` ForwardAuth: the webmail's
own login *is* the mailbox (and we're moving away from Google sign-in, so gating it
on Google would be both redundant and self-defeating). SnappyMail is the lean pick
for the Pi; Roundcube if you want the more familiar/heavier UI. (If Stalwart's
built-in web client proves sufficient, it can replace this component entirely —
verify its end-user webmail features first.)

## Phone & desktop clients

Standard IMAP/SMTP — add as an "Other / IMAP" account:

| | Server | Port | Security |
|---|---|---|---|
| Incoming (IMAP) | `mail.agu.com.ar` | 993 | SSL/TLS |
| Outgoing (SMTP) | `mail.agu.com.ar` | 465 (or 587) | SSL/TLS (or STARTTLS) |

User `fede@agu.com.ar` + mailbox password (or an **app-specific password** if 2FA
is enabled on the mailbox). Phone-sent mail submits to Stalwart, which relays via
SES — so even mail sent from the phone gets the good IP reputation.

**Push:** iOS Mail uses IMAP IDLE (near-instant). Android's stock Gmail app only
polls third-party IMAP; use **FairEmail** or **Thunderbird** for instant push, or a
JMAP client against Stalwart's JMAP.

## Migration runbook (sequenced so nothing breaks)

**Build & verify before touching Google.**

1. **Stand up the stack** (`charts/mailserver/` + `apps/mailserver.yaml`), SSD PV,
   SES out of sandbox, **SealedSecrets committed and unsealing verified**
   (`kubectl -n mailserver get secret`), DNS (MX/SPF/DKIM/DMARC) added with
   `mail.agu.com.ar` **grey**.
2. **Verify both directions** on a throwaway alias: receive from Gmail+Outlook,
   send to Gmail+Outlook, confirm **inbox placement** (not spam) and SPF/DKIM/DMARC
   `pass` (check headers / mail-tester.com). Test a **restic restore**.
3. **SSO audit** (the careful path you chose): myaccount.google.com → Security →
   *Sign in with Google / third-party connections*; cross-check your password
   manager. For each service, switch the login to **email + password** (recoverable
   via the self-hosted inbox) before cutover. Flag any service that *only* offers
   Google SSO and keys off the Google account ID — handle those deliberately.
4. **Migrate history** (the "some" mail you want): `imapsync` Google → Stalwart
   (XOAUTH2 or an app password on the Google side).
5. **Cutover:** flip the `MX` to `mail.agu.com.ar`; send/receive both ways from
   real senders; watch inbox placement for a few days.
6. **Soak, then cancel Workspace** — only after ~a week of clean operation. Keep an
   **external recovery email** (a free address elsewhere) as a permanent backstop
   so a Pi/SSD failure can't lock you out of password resets.

## Residual risks & mitigations

| Risk | Mitigation |
|---|---|
| Pi / internet / SSD failure → no password resets | offsite restic backups **+** an external recovery email |
| Inbound outage | senders retry hours→days; receiving resumes when the Pi is back |
| Outbound junked | **never let Stalwart send direct** — always via the SES smarthost |
| SSO-only services | audited & migrated to password+recovery in step 3 |
| SD-card mail store | mail lives on the **SSD PV**, not the SD card |

## Open items

- [ ] Confirm relay = **SES** (vs Mailgun/Postmark free tier) and request SES
      production access (region with rDNS, e.g. `sa-east-1`/`us-east-1`).
- [ ] Pick webmail: **SnappyMail** (recommended) vs Roundcube vs Stalwart built-in.
- [ ] Provision the USB SSD + PV/StorageClass for the mail store.
- [ ] Scaffold `charts/mailserver/` + `apps/mailserver.yaml`; add hostnames +
      per-host `PROXIED` to `charts/cloudflare-ddns`.
