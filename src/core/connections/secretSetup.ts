/**
 * How to set a connection's secrets where the app runs (#98). The app never holds a secret: each one is a
 * server setting the connection names. For each platform, the exact commands, with <value> where the key
 * goes, so it never passes through the app, the company file or the chat.
 */
export const SECRET_TARGETS = ['env', 'compose', 'gcp', 'aws', 'azure', 'fly', 'render', 'railway'] as const;
export type SecretTarget = (typeof SECRET_TARGETS)[number];

export const SECRET_TARGET_LABEL: Record<SecretTarget, string> = {
  env: 'This computer (.env)',
  compose: 'A server with Docker Compose',
  gcp: 'Google Cloud',
  aws: 'AWS',
  azure: 'Azure',
  fly: 'Fly.io',
  render: 'Render',
  railway: 'Railway',
};

export interface SecretSetup { target: SecretTarget; label: string; steps: Array<{ text: string; command?: string }> }

/** The steps to set these settings on a platform, then make the app read them. */
export function secretSetup(names: string[], target: SecretTarget, company = '<company>'): SecretSetup {
  const lines = (f: (n: string) => string) => names.map(f).join('\n');
  const kebab = (n: string) => n.replace(/^CONNECTION_/, '').toLowerCase().replace(/_/g, '-');
  const steps: SecretSetup['steps'] = (() => {
    switch (target) {
      case 'env': return [
        { text: 'Add these lines to the .env file next to the app, with each value from the guide:', command: lines((n) => `${n}=<value>`) },
        { text: 'Restart the app so it reads them.' },
      ];
      case 'compose': return [
        { text: "Add these lines to the kit's .env on the server:", command: lines((n) => `${n}=<value>`) },
        { text: 'Restart the app:', command: 'docker compose up -d' },
      ];
      case 'gcp': return [
        { text: 'From the kit, deploy again with the values given only to this command. Each one goes to Secret Manager and is mounted on the service:', command: `${names.map((n) => `${n}='<value>'`).join(' ')} deploy/gcp.sh <version>` },
        { text: `They are kept as ${names.map((n) => `${company}-connection-${kebab(n)}`).join(', ')}; later deploys mount them again.` },
      ];
      case 'aws': return [
        { text: "Add these lines to the kit's .env, then deploy again; each goes to Secrets Manager as fleet/<company>/<NAME>:", command: `${lines((n) => `${n}=<value>`)}\ndeploy/aws.sh <version>` },
      ];
      case 'azure': return [
        { text: "Add these lines to the kit's .env, then deploy again; each goes to Key Vault:", command: `${lines((n) => `${n}=<value>`)}\ndeploy/azure.sh <version>` },
      ];
      case 'fly': return [
        { text: 'Set them as Fly secrets; the app restarts with them:', command: `fly secrets set ${names.map((n) => `${n}='<value>'`).join(' ')} --app fleet-${company}` },
      ];
      case 'render': return [
        { text: `In Render: the fleet-${company} service → Environment → Add environment variable, once for each:`, command: names.join('\n') },
        { text: 'Save; Render deploys again with them.' },
      ];
      case 'railway': return [
        { text: 'Set them on the service, then deploy again:', command: `${names.map((n) => `railway variables --set '${n}=<value>'`).join('\n')}\nrailway up --detach` },
      ];
    }
  })();
  return { target, label: SECRET_TARGET_LABEL[target], steps };
}
