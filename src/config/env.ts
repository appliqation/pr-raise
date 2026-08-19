import 'dotenv/config';
import { required, optional } from '@appliqation/agent-core/config';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  // This agent's own GitHub token — deliberately NOT the per-project PAT
  // appq stores (appq never hands that out to this client; it only ever
  // returns repo_url/branch/tests_dir via get_project_settings, no
  // credentials). The operator running this agent supplies their own.
  githubToken: () => required('GITHUB_TOKEN'),
  gitAuthorName: optional('GIT_AUTHOR_NAME') ?? 'Appliqation PR Agent',
  gitAuthorEmail: optional('GIT_AUTHOR_EMAIL') ?? 'noreply@appliqation.io',
  commandTimeoutMs: Number(optional('COMMAND_TIMEOUT_MS') ?? 2 * 60 * 1000),
};
