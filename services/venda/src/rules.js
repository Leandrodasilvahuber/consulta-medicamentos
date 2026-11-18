/** Regras puras de venda conforme receita (testáveis sem infraestrutura). */
export function validateAgainstPrescription(prescription, cart, customerId, now = new Date()) {
  const errors = [];
  if (!prescription) return ['receita não encontrada'];
  if (prescription.customerId !== customerId) errors.push('receita pertence a outro paciente');
  if (new Date(prescription.expiresAt) < now) errors.push('receita vencida');
  for (const item of cart) {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      errors.push(`${item.sku}: quantidade inválida`);
      continue;
    }
    const rx = prescription.items.find((i) => i.sku === item.sku);
    const used = prescription.used?.[item.sku] || 0;
    if (!rx) errors.push(`${item.sku} não consta na receita`);
    else if (used + item.qty > rx.maxQty) errors.push(`${item.sku}: limite ${rx.maxQty}, já usado ${used}`);
  }
  return errors;
}
