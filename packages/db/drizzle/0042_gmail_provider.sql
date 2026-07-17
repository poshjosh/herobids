-- Seed gmail provider
INSERT INTO providers (id, name, capabilities, status, provider_type, meta)
VALUES (
  'gmail',
  'Gmail',
  '["email"]',
  'active',
  'messaging',
  '{
    "authMethod": "oauth2",
    "iconUrl": "/assets/providers/gmail.svg",
    "docsUrl": "https://developers.google.com/gmail/api",
    "oauth": {
      "authUri": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUri": "https://oauth2.googleapis.com/token",
      "revokeUri": "https://oauth2.googleapis.com/revoke",
      "scopes": [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly"
      ]
    }
  }'::jsonb
) ON CONFLICT (id) DO NOTHING;
