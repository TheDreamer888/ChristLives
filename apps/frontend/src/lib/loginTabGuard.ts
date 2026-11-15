export async function runUnauthenticatedGuard(
  hasSession: boolean,
  termsAccepted: boolean,
  privacyAccepted: boolean,
  recordConsent: (termsAccepted: boolean, privacyAccepted: boolean) => Promise<void>,
  action: () => Promise<void>,
): Promise<void> {
  if (!hasSession) {
    if (!termsAccepted || !privacyAccepted) {
      throw new Error("Aceita os Termos e a Política de Privacidade para continuar.");
    }
    await recordConsent(termsAccepted, privacyAccepted);
  }
  await action();
}
