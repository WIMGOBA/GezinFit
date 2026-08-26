// Vercel Cron Job — draait elke maandag om 06:00
// Genereert automatisch recepten voor de volgende week

export default async function handler(req, res) {
  // Vercel stuurt een Authorization header voor cron jobs
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://ybzwmbygsfutfjjsmwvz.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseServiceKey || !anthropicKey) {
    return res.status(500).json({ error: 'Missende environment variables' });
  }

  const sbFetch = async (path, options = {}) => {
    const r = await fetch(supabaseUrl + '/rest/v1' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': 'Bearer ' + supabaseServiceKey,
        ...(options.headers || {})
      }
    });
    if (!r.ok) throw new Error('Supabase fout: ' + await r.text());
    return r.headers.get('content-type')?.includes('json') ? r.json() : null;
  };

  // Bereken volgende week (maandag)
  const nu = new Date();
  const dag = nu.getDay();
  const diff = dag === 0 ? 1 : 8 - dag;
  const volgendeMaandag = new Date(nu);
  volgendeMaandag.setDate(nu.getDate() + diff);
  const weekStart = volgendeMaandag.toISOString().split('T')[0];

  try {
    // Haal alle gezinnen op
    const gezinnen = await sbFetch('/families?select=id');
    
    const resultaten = [];
    for (const gezin of gezinnen || []) {
      // Check of volgende week al gevuld is
      const bestaand = await sbFetch(
        `/recipes?family_id=eq.${gezin.id}&week_start=eq.${weekStart}&archived=eq.false&select=id&limit=1`
      );
      if (bestaand && bestaand.length > 0) {
        resultaten.push({ family_id: gezin.id, status: 'al gevuld' });
        continue;
      }

      // Haal gezinsdata op
      const leden = await sbFetch(`/family_members?family_id=eq.${gezin.id}&select=*`);
      const commentaar = ''; // Kan later uitgebreid worden

      // Stuur naar de genereer function
      const resp = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/generate-recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: gezin.id,
          userId: leden?.[0]?.user_id || null,
          members: leden || [],
          forbidden: [],
          seizoen: (() => {
            const m = new Date().getMonth();
            return m<=1||m===11?'winter':m<=4?'lente':m<=7?'zomer':'herfst';
          })(),
          weekStart,
          receptenPerBatch: 7,
          avgKcal: 2000,
          budgetPP: 5,
          winkels: 'AH/Jumbo',
          cookingTime: 45,
          cookingTimeWknd: 60,
          seizoenTip: 'Pas aan op het seizoen',
          sportPerDag: '',
          activeFavIds: [],
          commentaar
        })
      });

      const data = await resp.json();
      resultaten.push({ 
        family_id: gezin.id, 
        status: resp.ok ? 'gegenereerd' : 'fout',
        detail: data
      });
    }

    return res.status(200).json({ resultaten, weekStart });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
