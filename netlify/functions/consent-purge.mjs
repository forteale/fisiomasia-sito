// Pulizia automatica del registro consensi: ogni giorno cancella i record più vecchi di 24 mesi
// (periodo di conservazione indicato nell'informativa privacy).
import { getStore } from "@netlify/blobs";

const MESI = 24;

export default async () => {
  const limite = new Date();
  limite.setMonth(limite.getMonth() - MESI);
  const soglia = limite.toISOString(); // le chiavi iniziano con la data ISO: confronto tra stringhe
  const store = getStore("consents");
  let cancellati = 0;
  try {
    const { blobs } = await store.list();
    for (const b of blobs) {
      if (b.key < soglia) { await store.delete(b.key); cancellati++; }
    }
  } catch (e) {
    console.log("consent-purge errore", e && e.message);
  }
  console.log(`consent-purge: cancellati ${cancellati} record anteriori a ${soglia}`);
};

export const config = { schedule: "@daily" };
