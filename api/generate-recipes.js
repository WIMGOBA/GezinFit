// Vercel Serverless Function — genereert recepten via Anthropic API
// Draait op de server zodat de telefoon het scherm mag uitzetten

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    familyId,
    members,
    forbidden,
    seizoen,
    weekStart,
    batchNum,
    namenTeVermijden,
    receptenPerBatch,
    avgKcal,
    budgetPP,
    winkels,
    cookingTime,
    seizoenTip,
    sportPerDag
  } = req.body;

  // API key van Vercel environment variable (veilig, niet uit de app)
  const apiKey = process.env.ANTHROPIC_API_KEY || req.body.apiKey;

  if (!apiKey || !familyId) {
    return res.status(400).json({ error: 'Missende verplichte velden' });
  }

  try {
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

    const prompt = `Maak PRECIES ${receptenPerBatch} avondrecepten voor ${(members||[]).length} personen.
GEZIN: ${memberDetails || 'geen beperkingen'}
VERBODEN (gebruik NOOIT): ${(forbidden||[]).length ? forbidden.join(', ') : 'niets'}
GV verplicht. Max ${cookingTime} min. ~${avgKcal} kcal p.p. Budget €${budgetPP}/p/dag. Winkel: ${winkels || 'AH/Jumbo'}.
SEIZOEN (${seizoen}): ${seizoenTip} ${zomerFilter}
SPORTSCHEMA: ${sportPerDag || 'geen sport — verdeel gelijkmatig over de week'}
${namenTeVermijden ? 'NIET: ' + namenTeVermijden : ''}

VERPLICHT: geef bij elk recept een realistisch 'cost_pp' bedrag in euros (bijv. 2.50, 3.80, 5.00).

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
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Anthropic API fout' });
    }

    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return res.status(500).json({ error: 'Geen geldige JSON ontvangen van AI' });
    }

    let recepten;
    try {
      recepten = JSON.parse(match[0]);
    } catch (e) {
      try {
        recepten = JSON.parse(match[0].replace(/,\s*\{[^{]*$/, ']'));
      } catch (e2) {
        return res.status(500).json({ error: 'JSON parse fout: ' + e.message });
      }
    }

    // Fallback kostprijs
    (recepten || []).forEach(r => {
      if (!r.cost_pp || r.cost_pp === 0) {
        const naam = (r.name || '').toLowerCase();
        if (naam.includes('zalm') || naam.includes('garnaal')) r.cost_pp = 5.50;
        else if (naam.includes('biefstuk') || naam.includes('entrecote')) r.cost_pp = 7.00;
        else if (naam.includes('kip') || naam.includes('gehakt')) r.cost_pp = 3.80;
        else if (naam.includes('pasta') || naam.includes('soep') || naam.includes('rijst')) r.cost_pp = 2.80;
        else r.cost_pp = 3.50;
      }
    });

    return res.status(200).json({ recepten, batchNum });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
