# Message to paste into the "Attendance Pro - Chat 2" session (runs on the owner's computer)

From the owner's cloud session (repo RohanAgarwal346/trex, branch ccr-c6115f25-h3ht1a, folder apps/staff). Do this only if it fits what the owner wants, and do not change any existing Attendance Pro behaviour.

I built a "Rohpo Staff" hub app (Android + a small Node server). Staff log in there with mobile + PIN and the hub forwards each event to the owner's existing systems as an HTTPS POST with JSON and header `x-hub-key: <secret>`. It retries until the receiver answers HTTP 200 with `{"ok":true}` (any `{"ok":false,"error":"..."}` is retried later). Please create these receiving endpoints and tell the owner (in Hindi) the final URLs and secrets to paste into the hub admin panel (Settings -> Connectors):

1) ATTENDANCE -> Attendance Pro (Apps Script web app)
`{"module":"attendance","event_id":"att-123","type":"in"|"out","staff":"Ramesh Kumar","mobile":"9876543210","godown":"Main Godown","time":"2026-11-02T10:05:00+05:30","lat":22.57,"lng":88.36,"distance_m":42}`
The hub already verified the 100 m geofence. Record it as a normal punch for the staff matched by mobile; ignore a repeated event_id.

2) RECEIPT -> Tally Live (and from there into Tally)
`{"module":"receipt","event_id":"rc-45","date":"2026-11-02","party":"Phoolchand & Sons","amount":5000,"mode":"cash"|"upi"|"bank"|"cheque","bills":[{"ref":"INV-102","amount":3000}],"narration":"","staff":"Ramesh Kumar"}`
Create a Receipt voucher in Tally (party ledger credited, Cash/Bank ledger debited, bills as "Agst Ref", remainder "On Account"); ignore a repeated event_id.

3) ORDER -> Tally Live (later; can be a Sales Order)
`{"module":"order","event_id":"od-7","date":"2026-11-02","party":"Ram Traders","items":[{"name":"Sugar 50kg","qty":10,"rate":2100}],"note":"","staff":"Ramesh Kumar"}`

Also tell the owner which Tally Live endpoint returns the customer (Sundry Debtors) name list, so the hub can offer a pick-list (the hub currently gets it from a small bridge program on the Tally PC). Generate a new random secret for each endpoint; never put passwords or keys in chat messages to other sessions.
