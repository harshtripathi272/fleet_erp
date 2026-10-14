export async function getHealth() {
  return { status: 'ok', service: 'fleet-erp', timestamp: new Date().toISOString() };
}
