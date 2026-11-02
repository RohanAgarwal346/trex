# हैंडओवर: Rohpo Staff हब ऐप को Attendance Pro और Tally Live से जोड़ना

(यह पूरा लिखा हुआ "Attendance Pro - Chat 2" वाली चैट में पेस्ट करना है। वह चैट मालिक के कंप्यूटर पर चलती है और Apps Script, Tally, फ़ाइलें सब खुद खोल सकती है।)

---

## तुम्हारे लिए काम (मालिक अनिल ने कहा है कि यह सब अपने आप करो; मुझसे बार-बार मत पूछो, सिर्फ़ पैसे/खरीद/पासवर्ड वाली बातें पूछो)

मालिक का कारोबार ROHPO / New Punjab Stores है। एक दूसरी (क्लाउड) चैट में मैंने स्टाफ के लिए **"Rohpo Staff" हब ऐप** बनाया है। उसमें स्टाफ मोबाइल नंबर + PIN से लॉगिन करता है और तीन काम करता है: 📍 गोडाउन से हाज़िरी (100 मीटर जियोफ़ेंस), 💰 ग्राहक से रसीद, 🛒 ऑर्डर। हब हर काम को सही सिस्टम में भेजता है: हाज़िरी → **Attendance Pro**, रसीद/ऑर्डर → **Tally Live → Tally**। आगे और काम भी जुड़ेंगे।

कोड GitHub पर है (public): `https://github.com/RohanAgarwal346/trex`, ब्रांच `ccr-c6115f25-h3ht1a`, फ़ोल्डर `apps/staff/`.
पहले `apps/staff/README.md` और `apps/staff/CONNECT_MESSAGE.md` पढ़ो। (क्लाउड चैट से मैंने तुम्हें एक छोटा संदेश भेजा था, यह उसका पूरा रूप है।)

**ज़रूरी नियम:** Attendance Pro और Tally Live में जो अभी चल रहा है उसे बिगाड़ना नहीं। सिर्फ़ नए endpoint जोड़ो। कोई भी पासवर्ड, PIN या चाबी चैट में बड़े अक्षरों में मत छापो; फ़ाइल में सुरक्षित रखो और मालिक को सिर्फ़ ज़रूरी हो तो बताओ।

### चरण 1: सर्वर इसी कंप्यूटर पर चलाओ
1. रेपो को ब्रांच के साथ क्लोन करो (Desktop पर कहीं अलग फ़ोल्डर में)।
2. `apps/staff/server` में Node.js 22.13+ से सर्वर चलाओ: `ADMIN_PASSWORD=<नया मज़बूत पासवर्ड>`, पोर्ट 8080। `node --disable-warning=ExperimentalWarning server.js`। टेस्ट: `node --disable-warning=ExperimentalWarning test.js` (सब पास होने चाहिए)।
3. कंप्यूटर चालू होते ही सर्वर अपने आप चले (Windows Task Scheduler / startup)।
4. इंटरनेट पर HTTPS पता चाहिए ताकि स्टाफ के फ़ोन जुड़ सकें। मालिक के डोमेन `rohpo.in` का उपयोग करके `staff.rohpo.in` जैसा नाम Cloudflare Tunnel से जोड़ो। अगर डोमेन/Cloudflare के लिए मालिक का लॉगिन या मंज़ूरी चाहिए तो उनसे माँगो। (अगर मालिक को हर समय चालू सर्वर चाहिए तो बाद में सस्ता VPS सुझाओ; यह मालिक को ही खरीदना होगा।)

### चरण 2: हब में गोडाउन और स्टाफ भरो (Admin पैनल `/admin` या उसके API से)
- गोडाउन: Attendance Pro में जो गोडाउन लोकेशन/दायरा पहले से सेट है वही लो (पुरानी चैट में कुछ ऐसा था: केंद्र 22.5947841, 88.3544489, दायरा 80 मीटर; पक्का करने के लिए Attendance Pro की सेटिंग देखो)।
- स्टाफ: Attendance Pro की स्टाफ लिस्ट से नाम और मोबाइल लो। हर किसी के लिए नया 4-6 अंकों का PIN बनाओ और उसकी सूची मालिक की फ़ाइल (Desktop पर "Rohpo Staff PIN list.txt") में रखो।

### चरण 3: Attendance Pro को endpoint दो (Apps Script `doPost`)
`CONNECT_MESSAGE.md` में हाज़िरी का पेलोड है (`module: "attendance"`, `event_id`, `type` in/out, `mobile`, `godown`, `time`, `lat`, `lng`)। मोबाइल से स्टाफ पहचानकर सामान्य punch दर्ज करो, `event_id` दोबारा आए तो अनदेखा करो, अंत में `{"ok":true}` लौटाओ, गलती हो तो `{"ok":false,"error":"..."}`। हेडर `x-hub-key` की जाँच करो (Apps Script में हेडर नहीं पढ़ सकते तो चाबी URL के पैरामीटर `?key=` से लो और हब के कनेक्टर URL में जोड़ दो)। नया Deploy करो और `/exec` URL नोट करो।

### चरण 4: Tally Live को endpoint दो
`CONNECT_MESSAGE.md` के रसीद पेलोड से Tally में **Receipt voucher** बनाओ (ग्राहक खाता Cr, Cash/Bank खाता Dr, बिल "Agst Ref", बाकी "On Account"), दोहराव अनदेखा। ऑर्डर पेलोड (Sales Order) भी, पर यह बाद में हो सकता है। ग्राहक (Sundry Debtors) की नाम-सूची हब को देने का तरीका भी बताओ (या `apps/staff/tally-bridge` इसी कंप्यूटर पर चलाओ: `config.json` में serverUrl + bridgeKey डालकर; Tally में Connectivity → port 9000)।

### चरण 5: हब को जोड़ो
हब Admin → Settings → Connectors में हर काम का URL और चाबी डालो (API: `PUT /api/admin/settings` में `connectors`)।

### चरण 6: APK बनाओ, सर्वर का पता अंदर डालकर
`apps/staff/mobile/www/config.js` में `SERVER_URL` अपना HTTPS पता डालो और ब्रांच पर push करो (push से GitHub Actions अपने आप APK बनाता है: Actions → "Build Ropo Staff APK" → Release `staff-v1.0.N` में `Ropo-Staff.apk`)। APK को Desktop पर "Rohpo Staff.apk" नाम से रखो और मालिक को चैट में भेजो। (बिना signing key वाला APK debug-signed होता है; नया APK डालने से पहले पुराना हटाना पड़ेगा। मालिक से पूछकर GitHub Secrets में `ANDROID_KEYSTORE_B64` आदि डालने का तरीका समझाओ।)

### चरण 7: अंत से अंत तक जाँच
हब पर एक टेस्ट स्टाफ बनाकर: (क) गोडाउन के पास से punch → Attendance Pro में दिखे, (ख) 100 मीटर से बाहर → मना हो, (ग) टेस्ट रसीद → Tally में voucher बने (टेस्ट वाउचर के बाद मालिक को बताओ कि कौन सा डिलीट करना है), (घ) सर्वर बंद करके रसीद → बाद में अपने आप पहुँचे। जो जाँचा और जो नहीं जाँचा, वह हिंदी में साफ़ लिखो।

### मालिक को हिंदी में अंत में बताओ
- सर्वर का पता, Admin का पता, और पासवर्ड/PIN वाली फ़ाइल कहाँ रखी।
- APK कहाँ है और स्टाफ को कैसे देना है।
- क्या-क्या अपने आप चलता है, और क्या मालिक को खुद करना है (अगर कुछ भी बचा हो)।
