// Vercel Serverless Function — genereert recepten en slaat ze direct op in Supabase
// Browser hoeft niet open te blijven — server doet alles zelf

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    familyId,
    userId,
    members,
    forbidden,
    seizoen,
    weekStart,
    receptenPerBatch,
    avgKcal,
    budgetPP,
    winkels,
    cookingTime,
    cookingTimeWknd,
    seizoenTip,
    sportPerDag,
    activeFavIds
    commentaar
  } = req.body;

  const apiKey = process.env.ANTHROPIC_API_KEY || req.body.apiKey;
  const supabaseUrl = process.env.SUPABASE_URL || 'https://ybzwmbygsfutfjjsmwvz.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!apiKey || !familyId || !supabaseServiceKey) {
    return res.status(400).json({ error: 'Missende verplichte velden' });
  }

  const supabaseFetch = async (path, options = {}) => {
    const r = await fetch(supabaseUrl + '/rest/v1' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': 'Bearer ' + supabaseServiceKey,
        'Prefer': 'return=minimal',
        ...(options.headers || {})
      }
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error('Supabase fout: ' + err);
    }
    return r.headers.get('content-type')?.includes('json') ? r.json() : null;
  };

  const zomerFilter = (seizoen === 'zomer' || seizoen === 'lente')
    ? 'GEEN stampot, hutspot, erwtensoep, boerenkool of zware stoofpotten.'
    : '';

  const memberDetails = (members || []).map(m => {
    const parts = [];
    const allergies = (m.allergies || []).filter(a => a !== 'Geen');
    const dislikes = (m.prefs || []).filter(p => p.startsWith('Geen ')).map(p => p.replace('Geen ', ''));
    if (allergies.length) parts.push('ALLERGISCH voor: ' + allergies.join(', '));
    if (dislikes.length) parts.push('LUST NIET: ' + dislikes.join(', '));
    return parts.length ? m.name + ' → ' + parts.join(' | ') : m.name;
  }).join(' | ');

  const doCall = async (namenTeVermijden = '') => {
    const prompt = `Maak PRECIES ${receptenPerBatch} avondrecepten voor ${(members||[]).length} personen.
GEZIN: ${memberDetails || 'geen beperkingen'}
VERBODEN (gebruik NOOIT): ${(forbidden||[]).length ? forbidden.join(', ') : 'niets'}
GV verplicht. Max ${cookingTime} min. ~${avgKcal} kcal p.p. Budget €${budgetPP}/p/dag. Winkel: ${winkels || 'AH/Jumbo'}.
SEIZOEN (${seizoen}): ${seizoenTip} ${zomerFilter}
SPORTSCHEMA: ${sportPerDag || 'geen sport — verdeel gelijkmatig over de week'}
${namenTeVermijden ? 'NIET dezelfde als: ' + namenTeVermijden : ''}
${commentaar ? 'EXTRA WENS: ' + commentaar : ''}
VERPLICHT: geef bij elk recept een realistisch 'cost_pp' bedrag in euros.

JSON array, PRECIES ${receptenPerBatch} recepten:
[{"name":"...","kcal":500,"prot":40,"time_min":30,"low_carb":false,"gv":true,"cost_pp":3.50,"tip":"...","days":[0],"ingredients":[["product","hoeveelheid"]],"steps":["stap1","stap2"]}]
days: 0=ma 1=di 2=wo 3=do 4=vr 5=za 6=zo`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 5000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic API fout');
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { return JSON.parse(match[0]); }
    catch (e) {
      try { return JSON.parse(match[0].replace(/,\s*\{[^{]*$/, ']')); }
      catch (e2) { return []; }
    }
  };

  try {
    // Genereer alle 3 batches
    const batch1 = await doCall('');
    const batch2 = await doCall(batch1.map(r => r.name).join(', '));
    const batch3 = await doCall([...batch1, ...batch2].map(r => r.name).join(', '));

    let recepten = [...batch1, ...batch2, ...batch3].filter(r => r && r.name);

    // Seizoensfilter
    const verboden = (seizoen === 'zomer' || seizoen === 'lente')
      ? ['stampot', 'stamppot', 'hutspot', 'stoofpot', 'erwtensoep', 'boerenkool', 'snert', 'zuurkool']
      : [];
    recepten = recepten.filter(r => !verboden.some(v => r.name.toLowerCase().includes(v)));
    recepten = recepten.slice(0, receptenPerBatch * 3);

    // Fallback kostprijs
    recepten.forEach(r => {
      if (!r.cost_pp || r.cost_pp === 0) {
        const naam = (r.name || '').toLowerCase();
        if (naam.includes('zalm') || naam.includes('garnaal')) r.cost_pp = 5.50;
        else if (naam.includes('biefstuk')) r.cost_pp = 7.00;
        else if (naam.includes('kip') || naam.includes('gehakt')) r.cost_pp = 3.80;
        else if (naam.includes('pasta') || naam.includes('soep') || naam.includes('rijst')) r.cost_pp = 2.80;
        else r.cost_pp = 3.50;
      }
    });

    // Archiveer bestaande niet-favorieten
    if (activeFavIds && activeFavIds.length > 0) {
      await supabaseFetch(`/recipes?family_id=eq.${familyId}&archived=eq.false&favorite=eq.false&week_start=eq.${weekStart}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true })
      });
    } else {
      await supabaseFetch(`/recipes?family_id=eq.${familyId}&archived=eq.false&week_start=eq.${weekStart}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true })
      });
    }

    // Sla nieuwe recepten op in Supabase
    const inserts = recepten.map(r => ({
      name: r.name,
      kcal: r.kcal,
      prot: r.prot,
      time_min: r.time_min,
      low_carb: r.low_carb || false,
      gv: r.gv || true,
      tip: r.tip || '',
      days: r.days || [0],
      ingredients: r.ingredients || [],
      steps: r.steps || [],
      cost_pp: r.cost_pp || null,
      family_id: familyId,
      is_default: true,
      created_by: userId,
      favorite: false,
      archived: false,
      week_start: weekStart,
      times_in_menu: 1
    }));

    await supabaseFetch('/recipes', {
      method: 'POST',
      body: JSON.stringify(inserts)
    });

    return res.status(200).json({ 
      success: true, 
      aantalRecepten: recepten.length,
      weekStart
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
