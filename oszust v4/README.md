# OSZUST – fixed v15

Najważniejsza poprawka: kolejka po pukaniu jest wyliczana zawsze względem aktualnego gracza (`game.turn`), a nie względem indeksu osoby pukającej.

- aktualny gracz + trafione pukanie -> zachowuje kolejkę
- aktualny gracz + pudło -> kolejka przechodzi na następnego gracza
- pukanie przez gracza spoza kolejki -> kolejka pozostaje bez zmian

Pozostałe mechaniki z v14 zostają zachowane.
