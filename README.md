# immowp-status

Sonde de la page de statut publique d'ImmoWP : <https://www.immowp.fr/status>.

Toutes les 30 minutes (au rythme réel du planificateur GitHub), le workflow
`status-probe` interroge depuis GitHub Actions, hors de l'infrastructure ImmoWP :

- `https://api.immowp.com/v1/health` — santé de l'API ;
- `https://update.immowp.fr/immowp_info.json` — manifeste de mise à jour du plugin ;
- `https://www.immowp.fr/` et le catalogue de démonstration.

Le résultat est publié sur la branche [`status-data`](../../tree/status-data) :

- `latest.json` — état courant ;
- `history.json` — relevés par jour, 90 jours glissants.

Le site les lit sans jeton :
`https://raw.githubusercontent.com/lebrunflorian/immowp-status/status-data/latest.json`.

Ce dépôt ne contient aucun secret et aucune donnée client. L'état par
connecteur métier (Apimo, Hektor, Netty…) n'est pas publié : il se consulte
dans `api_status.php`, protégé par la clé maître.

## Lancer en local

```bash
node status-probe.mjs --out /tmp/status-data
```
