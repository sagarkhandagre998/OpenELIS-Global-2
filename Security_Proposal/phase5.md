Phase 5 Security Audit — Infrastructure Hardening

This is the final phase of the five-part security audit, examining the deployment stack end-to-end: Docker Compose configuration, nginx reverse proxy, Tomcat hardening, HAPI FHIR server settings, secrets management, credential hygiene, and container isolation posture.

---

## Audit Scope — The Infrastructure Stack

The deployment consists of six services communicating inside a Docker bridge network:

```
Internet → nginx (proxy:80/443)
              ↓
   frontend (React dev server :3000)
   oe.openelis.org (Tomcat:8443) ← main app
   fhir.openelis.org (HAPI:8443) ← FHIR store
   db.openelis.org (PostgreSQL:5432)
   certs (cert generator, exits after run)
```

---

## P5-A: Hardcoded Default Credentials Shipped in Version-Controlled Files

### P5-A1 — Keystore/truststore passwords hardcoded across every Compose file

The **same four passwords** appear verbatim in every Compose variant (`docker-compose.yml`, `dev.docker-compose.yml`, `build.docker-compose.yml`, `test.docker-compose.yml`, analyzer harness, and template files):

```OpenELIS-Global-2/dev.docker-compose.yml#L7-9
environment:
    - KEYSTORE_PW="kspass"
    - TRUSTSTORE_PW="tspass"
```

```OpenELIS-Global-2/dev.docker-compose.yml#L104-109
JAVA_OPTS: "-Djavax.net.ssl.trustStore=/etc/openelis-global/truststore
            -Djavax.net.ssl.trustStorePassword=tspass
            ...
            -Djavax.net.ssl.keyStorePassword=kspass
```

`kspass` and `tspass` are the actual operational passwords used by the cert generator and all JVM SSL contexts. They are committed to version control in plain text. **Anyone with read access to the repository has the keystore passwords**, enabling them to decrypt the keystores if they also obtain the keystore files (which are generated deterministically by `itechuw/certgen:main`).

### P5-A2 — Default admin password hardcoded in all Compose files and CI workflows

```OpenELIS-Global-2/docker-compose.yml#L49-50
environment:
    - DEFAULT_PW=adminADMIN!
```

```OpenELIS-Global-2/.github/workflows/frontend-qa.yml#L210-216
TEST_PASS: ${{ secrets.TEST_PASS || 'adminADMIN!' }}
```

The default application admin password `adminADMIN!` is hardcoded as a fallback in CI workflows. If `secrets.TEST_PASS` is not set in GitHub, this literal password is used for E2E tests against a running stack. Deployments that skip post-install password rotation will be running with a publicly known admin credential.

### P5-A3 — Database superuser password hardcoded

```OpenELIS-Global-2/volume/database/database.env#L1-4
POSTGRES_USER=postgres
POSTGRES_PASSWORD=admin
POSTGRES_DB=clinlims
POSTGRES_INITDB_ARGS="--auth-host=md5"
```

```OpenELIS-Global-2/volume/properties/datasource.password#L1
clinlims
```

The PostgreSQL superuser password is `admin` (trivially guessable), and the application database user password is `clinlims` (same as the username). Both are committed to version control. The `datasource.password` file — used as a Docker Secret — contains the literal string `clinlims` committed in plaintext.

### P5-A4 — SSL passwords exposed in `CATALINA_OPTS` environment variable

```OpenELIS-Global-2/docker-compose.yml#L61-65
- CATALINA_OPTS= -Ddatasource.url=jdbc:postgresql://db.openelis.org:5432/clinlims
  -Ddatasource.username=clinlims
  -Ddatasource.password=${OE_DB_PASSWORD:-clinlims}
  -Doe.ssl.truststorepassword=${SSL_TRUSTSTORE_PASSWORD:-tspass}
  -Doe.ssl.keystorepassword=${SSL_KEYSTORE_PASSWORD:-kspass}
```

`CATALINA_OPTS` is an environment variable. **Environment variables are readable** via `docker inspect`, `/proc/1/environ` inside the container, and are included in debug output of many monitoring tools. Placing database passwords and keystore passwords in `CATALINA_OPTS` means they are exposed to any process running in the container and to anyone with Docker API access to the host.

### P5-A5 — `common.properties` with encryption password committed to VCS

```OpenELIS-Global-2/volume/properties/common.properties#L1-6
server.ssl.key-store-password = kspass
server.ssl.key-password = kspass
server.ssl.trust-store-password=tspass
encryption.general.password=kspass
```

The `encryption.general.password` value (`kspass`) is used by the `TextEncryptor` bean in `SecurityConfig` to encrypt sensitive configuration values at rest. Committing it to version control means any encrypted value in the database can be decrypted by anyone with repo access.

---

## P5-B: Database Port Exposed Directly to the Host

```OpenELIS-Global-2/docker-compose.yml#L23-25
db.openelis.org:
    ports:
        - "15432:5432"
```

```OpenELIS-Global-2/dev.docker-compose.yml#L24-26
db.openelis.org:
    ports:
        - "15432:5432"
```

**PostgreSQL port 5432 is mapped to host port 15432** in the default production Compose file (`docker-compose.yml`) and the dev Compose file. This means the database is directly reachable from outside the Docker network — from any process on the host, and from any network-level attacker who can reach the host on port 15432. Combined with P5-A3 (default password `clinlims`/`admin`), this is a trivial remote database compromise vector.

---

## P5-C: nginx — `proxy_ssl_verify off` Disables Backend TLS Verification

```OpenELIS-Global-2/volume/nginx/nginx.conf#L49-53
location /api/ {
    proxy_pass https://oe.openelis.org:8443/api/;
    proxy_redirect off;
    proxy_ssl_verify off;        ← TLS certificate not verified
    proxy_ssl_server_name on;
    ...
}

location /rest/ {
    proxy_pass https://oe.openelis.org:8443/rest/;
    proxy_ssl_verify off;        ← same
```

`proxy_ssl_verify off` instructs nginx to **not verify the TLS certificate presented by the Tomcat backend**. This means:
- A compromised or misconfigured Tomcat container can present any certificate
- A network-level attacker who gains access to the Docker bridge network can impersonate the Tomcat backend to nginx with no certificate validation
- The TLS hop between nginx and Tomcat provides no authenticity guarantee

This pattern appears in three `location` blocks across both `nginx.conf` and `nginx-prod.conf`.

---

## P5-D: nginx — No Security Response Headers

Neither `nginx.conf` nor `nginx-prod.conf` sets **any** HTTP security response headers. The grep confirmed zero `add_header` directives across all nginx configuration files. Missing:

| Header | Risk of Absence |
|---|---|
| `Strict-Transport-Security` (HSTS) | Browser allows HTTP downgrade attacks |
| `X-Frame-Options` | Clickjacking of lab result or patient entry pages |
| `X-Content-Type-Options: nosniff` | MIME-type sniffing, content-type confusion |
| `Content-Security-Policy` | XSS amplification; inline script injection |
| `Referrer-Policy` | PHI in URLs leaks via `Referer` header to third-party scripts |
| `Permissions-Policy` | Camera/microphone/geolocation APIs available to page scripts |
| `server_tokens off` | nginx version disclosed in `Server` header and error pages |

The CSP that **is** present is defined in `SecurityConfig.java` for Spring MVC-served pages only — it does not apply to nginx-proxied responses, and it contains `'unsafe-inline'` and `'unsafe-eval'`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L111-113
private static final String CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    + " connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';"
```

`'unsafe-inline'` and `'unsafe-eval'` negate the XSS protection that CSP is meant to provide.

---

## P5-E: nginx — Outdated Base Image (`nginx:1.15-alpine`)

```OpenELIS-Global-2/nginx-proxy/Dockerfile#L1-3
FROM nginx:1.15-alpine

USER root
```

`nginx 1.15` was released in **2018** and is end-of-life. The current stable branch is 1.26+. nginx 1.15 contains multiple known CVEs, including:
- **CVE-2019-9511, CVE-2019-9513, CVE-2019-9516** — HTTP/2 DoS vulnerabilities
- **CVE-2021-23017** — Off-by-one in DNS resolver

The `dev.docker-compose.yml` `proxy` service directly uses `image: nginx:1.15-alpine` without the Dockerfile build, meaning even the dev-to-prod pipeline pulls this EOL image.

Furthermore, the `Dockerfile` builds as `USER root` with no subsequent `USER nginx` drop — meaning the nginx worker process runs as root inside the container.

---

## P5-F: HAPI FHIR Server — CORS Wildcard, OpenAPI UI, and `allow_external_references`

### P5-F1 — CORS wildcard allows any origin

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L(cors section)
cors:
  allow_Credentials: true
  allowed_origin:
    - '*'
```

The HAPI FHIR store accepts requests **from any origin** with credentials (`allow_Credentials: true`). This means any webpage visited by a user who has authenticated to the FHIR store can make credentialed cross-origin requests to read or write FHIR resources. Combined with the missing `IAuthorizationInterceptor` (P4-C), this is a complete CSRF+CORS bypass for the FHIR store.

### P5-F2 — OpenAPI/Swagger UI enabled in all environments

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L59
openapi_enabled: true
```

```OpenELIS-Global-2/fhir/hapi_application.yaml#L59
openapi_enabled: true
```

The Swagger UI at `/fhir/swagger-ui/index.html` is enabled in both the volume (runtime) and the checked-in `fhir/` directory config. The Swagger UI provides a full interactive browser of every FHIR endpoint, search parameter, and operation — without requiring authentication. This is a detailed reconnaissance tool for any attacker who reaches the FHIR server.

### P5-F3 — `allow_external_references: true` enables SSRF via FHIR references

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L99
allow_external_references: true
```

When `allow_external_references` is enabled, the HAPI FHIR server will resolve references in submitted resources that point to **external URLs** — including internal RFC1918 addresses. This means a resource submitted via the `/fhir/facade/` endpoint could contain a reference like `"reference": "http://internal-service/secret"` and cause the FHIR server to make an outbound HTTP request to that address. This is a **server-side request forgery (SSRF)** vector rooted in the FHIR store configuration.

---

## P5-G: Tomcat — HAPI Server.xml Has Active Shutdown Port and No Access Log

### P5-G1 — Shutdown port 8005 enabled on HAPI Tomcat

```OpenELIS-Global-2/tomcat/hapi_server.xml#L24
<Server port="8005" shutdown="SHUTDOWN">
```

The HAPI server's Tomcat listens on port 8005 for shutdown commands. The OE webapp server correctly disables this with `port="-1"`:

```OpenELIS-Global-2/tomcat/oe_server.xml#L24
<Server port="-1" shutdown="SHUTDOWN">
```

But the HAPI config has port 8005 active. Inside the Docker network, any container can `echo "SHUTDOWN" | nc fhir.openelis.org 8005` to gracefully stop the HAPI server — a trivial DoS.

### P5-G2 — Access log disabled on HAPI Tomcat

```OpenELIS-Global-2/tomcat/hapi_server.xml#L(access log section)
<!--         <Valve className="org.apache.catalina.valves.AccessLogValve" ... /> -->
```

The `AccessLogValve` is commented out in `hapi_server.xml`. All HTTP access to the FHIR store goes **unlogged at the Tomcat level**. Combined with no FHIR audit interceptor (P4-J), FHIR store access is completely invisible in logs.

### P5-G3 — `autoDeploy="true"` on Tomcat Host

```OpenELIS-Global-2/tomcat/oe_server.xml#L(Host element)
<Host name="localhost" appBase="webapps"
    unpackWARs="true" autoDeploy="true">
```

`autoDeploy="true"` means Tomcat continuously monitors the `webapps/` directory and automatically deploys any new `.war` or directory it finds. If an attacker gains write access to the `webapps/` volume (e.g., via a path traversal or a compromised plugin), they can drop a malicious WAR and have it deployed automatically without a restart.

---

## P5-H: Docker Compose — No Container Resource Limits

Across all Compose files, **no service defines `mem_limit`, `cpus`, or `pids_limit`**. This means:

- Any container (including the FHIR store or the webapp) can consume all available host memory and CPU — a container-level DoS that takes down the entire stack
- The transformation DoS identified in P4-D1 (unlimited async threads via `/PatientToFhir`) is amplified because there is no container memory ceiling to trigger an OOM kill before the host itself is affected

---

## P5-I: Docker Compose — No `read_only` Filesystem, No `no-new-privileges`

No service in any Compose file sets:
- `read_only: true` on the container filesystem
- `security_opt: ["no-new-privileges:true"]`
- `cap_drop: [ALL]` with selective `cap_add`

This means every container runs with a fully writable filesystem and the ability to gain additional Linux capabilities. If an application-layer exploit achieves code execution inside a container, the attacker has a writable filesystem to install tools and no privilege escalation constraints.

---

## P5-J: `docker-entrypoint.sh` Runs as Root Before Privilege Drop

```OpenELIS-Global-2/install/docker-entrypoint.sh#L1-50
#!/bin/sh

# ... fixes permissions as root ...
chown -R 8443:tomcat "$OE_LOGS" || true
chown -R 8443:tomcat "$TOMCAT_LOGS" || true

# Drop privileges & start Tomcat
exec su tomcat_admin -c "$CATALINA_HOME/bin/catalina.sh run"
```

The entrypoint runs as root to fix volume permissions, then drops to `tomcat_admin`. This is an acceptable pattern **but** relies on `exec su` rather than the Docker-native `USER` instruction — meaning if the permission-fixing commands fail or are exploited, the process stays root. Additionally, the `Dockerfile` ends with:

```OpenELIS-Global-2/Dockerfile#L71
USER root
```

The final instruction before `ENTRYPOINT` is `USER root`, which means **the container starts as root**. Docker best practice requires the final `USER` to be the non-root runtime user, with the entrypoint dropping privileges explicitly. Keeping `USER root` as the final Dockerfile instruction means any container orchestrator that ignores the entrypoint's `su` (e.g., a `docker exec` session, a Kubernetes `exec`) starts as root.

---

## P5-K: `common.properties` Committed with `org.openelisglobal.fhir.subscriber.allowHTTP=true`

```OpenELIS-Global-2/volume/properties/common.properties#L10
org.openelisglobal.fhir.subscriber.allowHTTP=true
```

This configuration flag explicitly permits the FHIR subscription webhook to be delivered over plain HTTP. FHIR subscriptions carry PHI-containing notifications (lab result ready, patient registered, etc.). With `allowHTTP=true`, subscription callbacks can be delivered unencrypted to any HTTP endpoint, enabling interception of PHI in transit.

---

## P5-L: `ServerInfo.properties` Version Mismatch (Minor Confusion Risk)

```OpenELIS-Global-2/install/tomcat-resources/ServerInfo.properties#L17-19
server.info=Apache Tomcat/9
server.number=9
server.built=
```

The running Tomcat is version 10 (`FROM tomcat:10-jre21` in Dockerfile), but the `Server` response header is spoofed to report `Apache Tomcat/9`. While obfuscating the real version is good practice, reporting a **different** version (9 vs 10) may mislead administrators checking vulnerability advisories. Better practice is a non-version-disclosing string entirely (e.g., `server.info=`).

---

## Risk Register — Phase 5

| ID | Area | Finding | Severity |
|---|---|---|---|
| **P5-A1** | Secrets | Keystore/truststore passwords (`kspass`/`tspass`) hardcoded in all Compose files in VCS | 🔴 Critical |
| **P5-A2** | Secrets | Admin password `adminADMIN!` hardcoded in Compose and CI fallback | 🔴 Critical |
| **P5-A3** | Secrets | DB superuser password `admin`, app password `clinlims` committed in `database.env` and `datasource.password` | 🔴 Critical |
| **P5-A4** | Secrets | DB + SSL passwords in `CATALINA_OPTS` env var (visible via `docker inspect`) | 🟠 High |
| **P5-A5** | Secrets | `encryption.general.password=kspass` committed — all encrypted config values decryptable | 🔴 Critical |
| **P5-B** | Network | DB port 5432 exposed on host as 15432 in production Compose | 🔴 Critical |
| **P5-C** | TLS | `proxy_ssl_verify off` — nginx does not verify Tomcat backend certificate | 🟠 High |
| **P5-D** | Headers | Zero HTTP security headers from nginx (no HSTS, X-Frame-Options, CSP, etc.) | 🟠 High |
| **P5-E** | Image | nginx EOL base image `1.15-alpine` (2018, multiple CVEs); runs as root | 🟠 High |
| **P5-F1** | FHIR | HAPI CORS wildcard `*` with `allow_Credentials: true` | 🔴 Critical |
| **P5-F2** | FHIR | OpenAPI/Swagger UI enabled on FHIR store in all environments | 🟠 High |
| **P5-F3** | FHIR | `allow_external_references: true` — SSRF via FHIR resource references | 🟠 High |
| **P5-G1** | Tomcat | Shutdown port 8005 active on HAPI Tomcat — DoS from any container | 🟠 High |
| **P5-G2** | Tomcat | Access log disabled on HAPI Tomcat — FHIR access unlogged | 🟠 High |
| **P5-G3** | Tomcat | `autoDeploy="true"` — arbitrary WAR deployment if webapps/ written | 🟡 Medium |
| **P5-H** | Container | No `mem_limit`, `cpus`, or `pids_limit` on any service | 🟠 High |
| **P5-I** | Container | No `read_only`, no `no-new-privileges`, no `cap_drop` | 🟠 High |
| **P5-J** | Container | Dockerfile ends `USER root`; entrypoint drops privileges via `su`, not `USER` | 🟡 Medium |
| **P5-K** | Config | `allowHTTP=true` for FHIR subscriptions — PHI in webhook traffic unencrypted | 🟠 High |
| **P5-L** | Tomcat | `ServerInfo.properties` reports wrong version (9 vs actual 10) | 🟡 Low |

---

## Concrete Remediation Patches

### Fix P5-A — Eliminate All Hardcoded Credentials

**Step 1: Remove passwords from Compose files.** Replace every hardcoded default with a mandatory env-var that has **no default**:

```OpenELIS-Global-2/docker-compose.yml#L7-9
# BEFORE:
- KEYSTORE_PW="kspass"
- TRUSTSTORE_PW="tspass"

# AFTER — no default; deployment fails loudly if not set:
- KEYSTORE_PW=${KEYSTORE_PW:?KEYSTORE_PW must be set}
- TRUSTSTORE_PW=${TRUSTSTORE_PW:?TRUSTSTORE_PW must be set}
```

**Step 2: Move all secrets to Docker Secrets.** The `datasource.password` Docker Secret pattern already exists and should be extended:

```/dev/null/docker-compose-fix.yml#L1-15
secrets:
  common.properties:
    file: ./volume/properties/common.properties
  datasource.password:
    file: ./volume/properties/datasource.password
  keystore.password:       # NEW
    external: true         # populated by CI/CD or operator, never a file in VCS
  truststore.password:     # NEW
    external: true
  admin.password:          # NEW
    external: true
  db.superuser.password:   # NEW
    external: true
```

**Step 3: Remove `datasource.password` and `database.env` from VCS.** Add to `.gitignore`:

```/dev/null/.gitignore-addition#L1-4
volume/properties/datasource.password
volume/properties/common.properties
volume/properties/hapi_application.yaml
volume/database/database.env
```

Provide `.example` template files instead (with placeholder values only), documented in `README.md`.

**Step 4: Move SSL passwords out of `CATALINA_OPTS`** using the same Docker Secrets + entrypoint file-reading pattern already established for `datasource.password`:

```OpenELIS-Global-2/install/docker-entrypoint.sh#L13-17
# Extend file_env_secret to cover SSL passwords:
file_env_secret "datasource.password"
file_env_secret "keystore.password"       # NEW
file_env_secret "truststore.password"     # NEW

# Then pass via CATALINA_OPTS:
# -Doe.ssl.keystorepassword=${keystore.password} (read from secret)
```

### Fix P5-B — Remove Database Port from Host Binding

```OpenELIS-Global-2/docker-compose.yml#L23-25
# REMOVE the ports section entirely from db.openelis.org in docker-compose.yml:
# ports:
#     - "15432:5432"

# Keep it only in dev.docker-compose.yml, restricted to localhost:
ports:
    - "127.0.0.1:15432:5432"
```

The database only needs to be reachable by other containers in the Docker bridge network, not by the host or external networks.

### Fix P5-C — Enable nginx Backend TLS Verification

```OpenELIS-Global-2/volume/nginx/nginx.conf#L49-53
location /api/ {
    proxy_pass https://oe.openelis.org:8443/api/;
    # REMOVE:  proxy_ssl_verify off;
    # ADD:
    proxy_ssl_verify      on;
    proxy_ssl_trusted_certificate /etc/nginx/certs/apache-selfsigned.crt;
    proxy_ssl_session_reuse on;
    ...
}
```

Since nginx and Tomcat share the same cert volume (`key_trust-store-volume`), nginx already has the CA cert available at `/etc/nginx/certs/` to perform verification.

### Fix P5-D — Add Security Headers to nginx

```OpenELIS-Global-2/volume/nginx/nginx.conf#L17-20
# ADD inside the https server block, at the top level (applies to all locations):
server_tokens off;

add_header Strict-Transport-Security  "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options            "SAMEORIGIN" always;
add_header X-Content-Type-Options     "nosniff" always;
add_header Referrer-Policy            "strict-origin-when-cross-origin" always;
add_header Permissions-Policy         "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none';" always;
```

Also update the Spring Security CSP to remove `'unsafe-inline'` and `'unsafe-eval'` once the frontend is audited for inline script usage — those tokens negate XSS protection entirely.

### Fix P5-E — Update nginx Base Image and Drop Root

```OpenELIS-Global-2/nginx-proxy/Dockerfile#L1-5
# BEFORE:
FROM nginx:1.15-alpine
USER root

# AFTER:
FROM nginx:1.27-alpine
# Do NOT set USER root; nginx drops to the nginx user automatically.
# If root is needed for initial setup, use multi-stage or entrypoint with explicit drop.
```

### Fix P5-F — Harden HAPI FHIR Configuration

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L(cors section)
# BEFORE:
cors:
  allow_Credentials: true
  allowed_origin:
    - '*'

# AFTER — restrict to known OE origins only:
cors:
  allow_Credentials: true
  allowed_origin:
    - 'https://oe.openelis.org'
    - 'https://frontend.openelis.org'
```

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L59
# Disable Swagger UI in non-development environments:
openapi_enabled: false
```

```OpenELIS-Global-2/volume/properties/hapi_application.yaml#L99
# Disable external reference resolution to eliminate SSRF:
allow_external_references: false
```

### Fix P5-G — Fix HAPI Tomcat Server Configuration

```OpenELIS-Global-2/tomcat/hapi_server.xml#L24
<!-- BEFORE: -->
<Server port="8005" shutdown="SHUTDOWN">

<!-- AFTER — disable shutdown port, consistent with oe_server.xml: -->
<Server port="-1" shutdown="SHUTDOWN">
```

```OpenELIS-Global-2/tomcat/hapi_server.xml#L(Host section)
<!-- RE-ENABLE access log: -->
<Valve className="org.apache.catalina.valves.AccessLogValve"
       directory="logs"
       prefix="fhir_access_log" suffix=".txt"
       pattern="%h %l %u %t &quot;%r&quot; %s %b %D"
       rotatable="true" />
```

```OpenELIS-Global-2/tomcat/oe_server.xml#L(Host element)
<!-- Change autoDeploy to false: -->
<Host name="localhost" appBase="webapps"
    unpackWARs="true" autoDeploy="false">
```

### Fix P5-H/I — Add Resource Limits and Security Options

```OpenELIS-Global-2/docker-compose.yml#L(oe.openelis.org service)
oe.openelis.org:
    ...
    # ADD:
    mem_limit: 2g
    cpus: 2.0
    pids_limit: 512
    security_opt:
        - no-new-privileges:true
    read_only: true
    tmpfs:
        - /tmp
        - /usr/local/tomcat/temp
        - /usr/local/tomcat/work
```

Apply proportionate limits to `fhir.openelis.org` (1.5g), `db.openelis.org` (1g), `proxy` (256m), and `frontend` (512m).

### Fix P5-J — Correct Dockerfile Final USER

```OpenELIS-Global-2/Dockerfile#L68-71
# BEFORE (last two lines):
COPY install/docker-entrypoint.sh /docker-entrypoint.sh
RUN chown tomcat_admin:tomcat /docker-entrypoint.sh; chmod 770 /docker-entrypoint.sh;
USER root                    ← this is wrong

ENTRYPOINT [ "/docker-entrypoint.sh" ]

# AFTER — the entrypoint handles the su, so drop root before ENTRYPOINT:
COPY install/docker-entrypoint.sh /docker-entrypoint.sh
RUN chown tomcat_admin:tomcat /docker-entrypoint.sh; chmod 770 /docker-entrypoint.sh;
# Remove USER root line — leave as tomcat_admin from the earlier RUN block
USER tomcat_admin

ENTRYPOINT [ "/docker-entrypoint.sh" ]
```

The entrypoint still needs to fix volume permissions — make it conditional (`if [ "$(id -u)" = "0" ]; then ... fi`) or switch to using `gosu` or `tini` as the supervisor.

### Fix P5-K — Disable HTTP for FHIR Subscriptions

```OpenELIS-Global-2/volume/properties/common.properties#L10
# BEFORE:
org.openelisglobal.fhir.subscriber.allowHTTP=true

# AFTER:
org.openelisglobal.fhir.subscriber.allowHTTP=false
```

---

## Phase 5 Conclusion

The infrastructure layer compounds all application-level risks found in Phases 1–4. The five most urgent items that require immediate action regardless of application code state are:

1. **P5-A1/A2/A3/A5** — Hardcoded credentials across the entire stack committed to VCS. This is the single highest-impact finding of the entire audit: anyone with repo read access has keys, passwords, and the encryption key for the application's configuration store. Rotate all credentials and move them to Docker Secrets or a vault before the next deployment.

2. **P5-B** — The database port is exposed on the host with default credentials. This combination is exploitable remotely with zero application interaction.

3. **P5-F1** — HAPI FHIR CORS wildcard with `allow_Credentials: true` enables any web page visited by an authenticated user to read or write any FHIR resource. Combined with P4-C (no HAPI `IAuthorizationInterceptor`), the FHIR store is completely open to credentialed cross-origin attacks.

P5-C** — `proxy_ssl_verify off` in nginx means the TLS termination between the public internet and Tomcat provides confidentiality but **no authenticity**. Any container in the Docker bridge network can impersonate the Tomcat backend to nginx with zero certificate checks. Fix this before enabling mutual TLS.

5. **P5-D** — The complete absence of HTTP security headers from nginx means the browser-level security model provides zero protection. HSTS absence allows downgrade attacks; the missing `X-Frame-Options` exposes every clinical workflow page to clickjacking; the permissive CSP with `'unsafe-inline'` and `'unsafe-eval'` means XSS defences are entirely ineffective at the browser layer.

---

## Full 5-Phase Audit Summary — Consolidated Risk Register

This table consolidates every confirmed finding across all five phases into a single prioritized backlog, ordered by severity and remediation sequence dependency.

### 🔴 Critical — Must Fix Before Next Release

| ID | Phase | Surface | Finding |
|---|---|---|---|
| **P3-I** | 3 | `SecurityConfig` | `@EnableMethodSecurity` absent — all `@PreAuthorize` annotations are runtime no-ops |
| **P3-A1** | 3 | `GET /rest/patient-search-results` | Full PHI search, no role gate |
| **P3-A2** | 3 | `GET /rest/patient-search` | Second unguarded PHI search endpoint |
| **P3-A3** | 3 | `GET /rest/patient-details?patientID=` | Full patient profile by enumerable integer DB ID |
| **P3-B** | 3 | `GET /rest/AuditTrailReport` | Full audit trail + embedded patient PHI snapshot, no auth |
| **P3-C** | 3 | `GET /rest/patient-photos/{id}` | Biometric photo endpoint, no ownership or role check |
| **P4-A1** | 4 | `GET /rest/fhir/{resourceType}` | Arbitrary resource type + all query params forwarded to FHIR store |
| **P4-A2** | 4 | `GET /rest/fhir/{resourceType}/{resourceId}` | Unguarded FHIR read traversal by type + ID |
| **P4-A3** | 4 | `POST /rest/fhir/{resourceType}/_search` | Attacker-controlled body forwarded verbatim to FHIR store |
| **P4-A4** | 4 | `GET /rest/fhir/{resourceType}/_search` | Entire query string passed through with zero filtering |
| **P4-B** | 4 | `GET/POST /fhir/**` | Wildcard FHIR passthrough proxy, no path sanitization, SSRF vector |
| **P4-C** | 4 | `/fhir/facade/*` | HAPI servlet bypasses Spring Security entirely; no `IAuthorizationInterceptor` |
| **P4-D1** | 4 | `GET /OEToFhir`, `/PatientToFhir` | On-demand bulk PHI transform + remote export, DoS via thread exhaustion |
| **P4-D3** | 4 | `POST /dataexport/fhir` | Triggers all export tasks to all remote FHIR servers; immediate PHI exfil |
| **P4-F** | 4 | `ExternalPatientSearch` | `ALLOW_ALL_HOSTNAME_VERIFIER` + credentials passed as URL query params |
| **P5-A1** | 5 | All Compose files | `kspass`/`tspass` keystore passwords hardcoded in VCS |
| **P5-A2** | 5 | Compose + CI | `adminADMIN!` admin password hardcoded as CI fallback |
| **P5-A3** | 5 | `database.env`, `datasource.password` | DB passwords `admin`/`clinlims` committed to VCS |
| **P5-A5** | 5 | `common.properties` | `encryption.general.password=kspass` committed — all encrypted config decryptable |
| **P5-B** | 5 | `docker-compose.yml` | PostgreSQL port 15432 exposed on host with default credentials |
| **P5-F1** | 5 | `hapi_application.yaml` | HAPI CORS wildcard `*` with `allow_Credentials: true` |

### 🟠 High — Fix Within Current Sprint

| ID | Phase | Surface | Finding |
|---|---|---|---|
| **P2-M1** | 2 | `SecurityConfig` | `@EnableMethodSecurity` missing (same root as P3-I, confirm fix) |
| **P3-D** | 3 | `GET /rest/home-dashboard/**` | National IDs embedded in dashboard order beans, no role check |
| **P3-E1** | 3 | `PatientSearchRestController` | Full name + national ID logged at INFO level |
| **P3-F** | 3 | `/import/**` | FHIR mass import endpoints, no admin gate |
| **P3-G** | 3 | `GET /rest/users`, `/rest/users/{role}` | Full user enumeration + role mapping, no admin gate |
| **P3-H** | 3 | 15+ service classes | `setSysUserId("1")` hardcoded — destroys audit trail non-repudiation |
| **P3-J** | 3 | `SecurityConfig` | CSRF blanket-disabled for all `/rest/**` |
| **P4-E** | 4 | `POST /fhir/optimizeStorage` | Triggers FHIR store `$reindex` — DoS, no admin gate, no rate-limit |
| **P4-G** | 4 | `FhirUtil.getFhirClient` | BasicAuth credentials attached without enforcing HTTPS on store URL |
| **P4-H** | 4 | `FhirConfig` | All four FHIR credentials publicly accessible via Lombok `@Getter` |
| **P4-I** | 4 | `FhirRestfulServer` | All `IResourceProvider` beans auto-discovered — future providers instantly exposed |
| **P4-J** | 4 | All FHIR surfaces | No FHIR access audit trail — breaches undetectable |
| **P5-A4** | 5 | `CATALINA_OPTS` | DB + SSL passwords in environment variable, visible via `docker inspect` |
| **P5-C** | 5 | `nginx.conf` | `proxy_ssl_verify off` — nginx does not verify Tomcat backend certificate |
| **P5-D** | 5 | `nginx.conf` | Zero HTTP security headers (no HSTS, X-Frame-Options, CSP, etc.) |
| **P5-E** | 5 | `nginx-proxy/Dockerfile` | EOL base image `nginx:1.15-alpine` (2018) with multiple known CVEs; runs as root |
| **P5-F2** | 5 | `hapi_application.yaml` | OpenAPI/Swagger UI enabled on FHIR store in all environments |
| **P5-F3** | 5 | `hapi_application.yaml` | `allow_external_references: true` — SSRF via FHIR resource references |
| **P5-G1** | 5 | `hapi_server.xml` | Shutdown port 8005 active on HAPI Tomcat — DoS from any container on the network |
| **P5-G2** | 5 | `hapi_server.xml` | Access log disabled on HAPI Tomcat — all FHIR HTTP access unlogged |
| **P5-H** | 5 | All Compose files | No `mem_limit`, `cpus`, or `pids_limit` on any service |
| **P5-I** | 5 | All Compose files | No `read_only`, `no-new-privileges`, or `cap_drop` on any container |
| **P5-K** | 5 | `common.properties` | `allowHTTP=true` — FHIR subscription webhooks deliver PHI over plain HTTP |

### 🟡 Medium — Schedule Within Next Milestone

| ID | Phase | Surface | Finding |
|---|---|---|---|
| **P2-E1** | 2 | Logo upload | Extension checked with `.contains()` instead of `endsWith()` case-insensitive |
| **P2-E2/E3** | 2 | Analyzer/sample import | Client-provided filename/MIME used to select parser |
| **P2-G1/G2** | 2 | Password policy | Country-specific weak policies; generator uses mutable String in memory |
| **P2-S1** | 2 | OCL ZIP import | ZIP Slip path traversal on entry names |
| **P3-E2** | 3 | `PatientSearchRestController` | Derived national ID (PHI) logged at INFO |
| **P3-K** | 3 | `PatientManagementRestController` | `PropertyUtils.copyProperties` mass assignment risk on patient entity |
| **P4-D2** | 4 | `GET /OEToFhir/info` | Internal transformation state (record counts, phases) exposed publicly |
| **P5-G3** | 5 | `oe_server.xml` | `autoDeploy="true"` — arbitrary WAR deployment if `webapps/` is writable |
| **P5-J** | 5 | `Dockerfile` | Final `USER root` before `ENTRYPOINT`; privilege drop deferred to `su` in entrypoint |

### 🟢 Low / Governance — Address in Ongoing Security Program

| ID | Phase | Finding |
|---|---|---|
| **P2-F1** | 2 | `sysUserId="1"` in scheduled/batch jobs — document intentional system account usage |
| **P2-N1** | 2 | TLS misconfiguration in external patient search (partially overlaps P4-F) |
| **P2-T1** | 2 | No single-session-per-user enforcement |
| **P3-E2** | 3 | Development `System.out.println` debug output in NCE controller production path |
| **P4-D2** | 4 | `/OEToFhir/info` transformation state disclosure |
| **P5-L** | 5 | `ServerInfo.properties` reports wrong Tomcat version (9 vs actual 10) |

---

## Recommended Remediation Sequence

Phases should be executed in this strict order — later phases depend on earlier ones being resolved:

**Sprint 0 — Credentials Emergency (do immediately, before any other work):**
1. Rotate all committed secrets (`kspass`, `tspass`, `adminADMIN!`, `clinlims`, `admin`)
2. Remove credential files from VCS and add to `.gitignore`
3. Provision Docker Secrets or a vault; update Compose files to use `external: true`
4. Remove database port host binding from `docker-compose.yml`

**Sprint 1 — Application Security Foundation:**
1. Add `@EnableMethodSecurity(prePostEnabled = true)` to `SecurityConfig` (P3-I / P2-M1)
2. Add `@PreAuthorize` to all patient search, audit trail, photo, user, and import endpoints
3. Fix CSRF scope in `SecurityConfig` — remove blanket `/rest/**` exemption
4. Register `IAuthorizationInterceptor` on HAPI servlet + restrict CORS to known origins

**Sprint 2 — FHIR Surface Lockdown:**
1. Add `ALLOWED_RESOURCE_TYPES` allowlist to `FhirQueryRestController`
2. Gate `/OEToFhir`, `/PatientToFhir`, `/dataexport/fhir`, `/fhir/optimizeStorage` to `ROLE_GLOBAL_ADMIN`
3. Fix `ExternalPatientSearch` TLS (remove trust-all, move credentials to `Authorization` header)
4. Disable HAPI OpenAPI UI and `allow_external_references`; fix HAPI CORS wildcard
5. Fix HAPI shutdown port and re-enable access log

**Sprint 3 — Infrastructure Hardening:**
1. Add nginx security headers; fix `proxy_ssl_verify`; update nginx base image
2. Add container resource limits and `no-new-privileges` to all Compose services
3. Fix `Dockerfile` final `USER` instruction; move PHI out of logs
4. Disable `autoDeploy` on Tomcat; fix `hapi_server.xml` shutdown port
5. Set `allowHTTP=false` for FHIR subscriptions

**Sprint 4 — Audit and Governance:**
1. Replace all `setSysUserId("1")` with `SecurityContextHolder`-based user resolution
2. Add FHIR access audit interceptor
3. Address file upload validation, ZIP Slip, and password policy findings
4. Establish secret rotation schedule and secret management runbook

---

## Final Observations

The audit across all five phases reveals a system with solid architectural intentions — layered services, Docker Secrets wiring for some credentials, Tomcat file permission hardening, a `catalina.properties` with strict compliance flags, and partial RBAC role plumbing in service code — but where the security controls consistently stop one step short of being effective:

- `@PreAuthorize` annotations exist but `@EnableMethodSecurity` was never added, making them inert
- Docker Secrets are wired for `datasource.password` but the secret file itself contains the default password committed to VCS
- TLS is deployed everywhere but `proxy_ssl_verify off` and `ALLOW_ALL_HOSTNAME_VERIFIER` negate its authenticity guarantees
- RBAC roles are modeled and checked in some places (Logbook, SampleEdit) but completely absent from the entire PHI and FHIR surface

The most important single line of code that would immediately reduce the blast radius across Phases 3 and 4 is:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L88-92
@Configuration
@EnableWebSecurity
@EnableMethodSecurity(prePostEnabled = true)   // ← this single annotation activates all @PreAuthorize guards
public class SecurityConfig {
```

And the most important infrastructure action is rotating and vaulting all committed secrets before any code change — because application-level fixes are irrelevant if database credentials are publicly readable from the repository's commit history.

---

This concludes the full five-phase security audit of OpenELIS Global 2. The complete finding set covers **authentication/session security** (Phase 1), **CORS/CSRF** (Phase 2), **PHI data exposure** (Phase 3), **FHIR endpoint security** (Phase 4), and **infrastructure hardening** (Phase 5), producing a total of **50+ confirmed findings** across critical, high, medium, and low severity bands, each with concrete file-level evidence and actionable remediation patches.