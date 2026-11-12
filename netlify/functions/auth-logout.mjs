// Logout area gestione — cancella il cookie di sessione.
export default async () => {
  const cookie = "fm_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  return new Response(null, {
    status: 302,
    headers: { location: "/accesso.html?out=1", "set-cookie": cookie },
  });
};
