// Agent-readable summary lines verbatim from plan §6 error contract table.
// These strings are the contract — never rename or paraphrase.

export const AGENT_SUMMARIES: Record<string, string> = {
  invalid_request:
    "Bad arguments: {{message}}. Adjust the inputs and call again.",
  unauthorized:
    "Authentication failed. See setup instructions in the tool's response.",
  quota_exceeded:
    "Plan quota exceeded: {{message}}. Upgrade at {{upgrade_url}} or wait for monthly reset.",
  ttl_exceeds_plan_limit:
    "Requested TTL exceeds plan max. Reduce TTL or upgrade at {{upgrade_url}}.",
  artifact_not_found:
    "Artifact {{id}} does not exist or is not visible to this tenant.",
  session_not_found:
    "No artifacts exist for session {{id}}. Sessions are synthesized from artifacts — create one first.",
  session_sealed:
    "Session {{id}} is sealed. Use a different session_id or unseal externally.",
  artifact_expired:
    "Artifact {{id}} expired at {{expires_at}}. Re-upload if still needed.",
  artifact_already_deleted:
    "Artifact {{id}} was deleted at {{deleted_at}}.",
  file_too_large:
    "File exceeds path limit. Use `request_upload_url` for files > 500 MB (Pro only).",
  upload_not_found:
    "Bytes for artifact {{id}} have not arrived at R2 yet. PUT to the presigned URL and retry.",
  rate_limited:
    "Rate limit hit ({{limit}}/min). Server requested retry in {{retry_after_seconds}}s — the MCP server will auto-retry once with backoff.",
};

export const AMBIGUOUS_COMPLETION_GUIDANCE = `Artifacta API failed mid-write on {{tool}}. The backend may or may not have created the record.
Before retrying:
- For request_upload_url: call list_artifacts with the same session_id/agent_id and a recent created_after to detect any pending artifact that was created.
- For create_download_link: there is no list-links API in v1; if the agent cannot tolerate a possible extra link, surface to the human user.
Retrying without checking risks creating a duplicate.`;

export const SERVER_5XX_SUMMARY =
  "Artifacta API returned {{status}}. Retried {{n}} times. If the issue persists, status at status.artifacta.io.";

export const TENANT_SUSPENDED_SUMMARY =
  "Account is scheduled for deletion — see https://app.artifacta.io/dashboard/account.";

export const AUTH_REMEDIATION_TEMPLATE =
  "Artifacta authentication failed: {{message}}. Set ARTIFACTA_API_KEY to a valid key from https://app.artifacta.io/dashboard/keys, or pass --api-key when launching the MCP server.{{keySuffix}}";
