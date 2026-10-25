# Historique Prisma archivé — 2026-10-25

Cet historique n'était pas rejouable sur une base vierge :

- le dépôt ne contenait que la migration `20260719102943_init` ;
- la base locale avait deux migrations supplémentaires, `20260719163416_snake_case_tables`
  et `20260719171614_is_active_field`, absentes du dépôt ;
- la migration `20261025000000_add_images` référençait la table `user`, qui n'existe
  pas après la migration `init` seule.

Une baseline unique, `20261025000000_baseline`, a été générée depuis le schéma
Prisma courant et marquée comme appliquée sur la base existante. Aucune table ni
donnée applicative n'a été supprimée.

Les dossiers de ce répertoire sont conservés pour audit. Prisma ne les lit plus :
seul `prisma/migrations` fait foi.

## Autres environnements

Si la base contient déjà le schéma courant :

```bash
npx prisma migrate resolve --applied 20261025000000_baseline
```

Si l'ancien historique est encore présent dans `_prisma_migrations`, il faut le
retirer avant de marquer la baseline appliquée :

```sql
DELETE FROM _prisma_migrations;
```

Cette opération ne touche pas aux tables applicatives, uniquement au suivi des
migrations. La base locale de développement a déjà été baselinée le 2026-10-25.

Pour une base vierge :

```bash
npx prisma migrate deploy
```
