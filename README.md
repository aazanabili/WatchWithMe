# Watch With Me

تطبيق TypeScript monorepo لبناء غرف مشاهدة جماعية: يختار المضيف الوسيط ويتحكم في
التشغيل، بينما يتابع المشاهدون الحالة نفسها ويمكنهم المحادثة والمشاركة في مؤتمر
صوت/فيديو عند منحهم الصلاحية. PostgreSQL هو التخزين الدائم للغرف والمشاركين، وRedis
للمحادثة المؤقتة وطابور وظائف الوسائط، وMinIO للوسائط، وLiveKit/coturn للمؤتمر.

> هذا المستند يصف التطوير المحلي وCompose في هذا المستودع، وليس إعداد إنتاج جاهزاً.
> لا تنسخ أسرار التطوير أو إعدادات `network_mode: host` إلى الإنتاج دون مراجعة أمنية.

## المحتويات

- [الميزات والحدود](#الميزات-والحدود)
- [المعمارية وتدفق البيانات](#المعمارية-وتدفق-البيانات)
- [المتطلبات](#المتطلبات)
- [الإعداد والأسرار](#الإعداد-والأسرار)
- [Quick Start](#quick-start)
- [مرجع أوامر السكربت](#مرجع-أوامر-السكربت)
- [المنافذ والبروتوكولات والتعرض](#المنافذ-والبروتوكولات-والتعرض)
- [استخدام الغرفة](#استخدام-الغرفة)
- [الاختبارات والتطوير المحلي](#الاختبارات-والتطوير-المحلي)
- [استكشاف الأخطاء](#استكشاف-الأخطاء)
- [الإيقاف والتنظيف](#الإيقاف-والتنظيف)
- [الأمان والخصوصية والإتاحة وSEO](#الأمان-والخصوصية-والإتاحة-وseo)
- [قائمة نشر](#قائمة-نشر)

## الميزات والحدود

- إنشاء غرفة من `/create` والانضمام من `/join` باسم عرض ورمز/رابط دعوة.
- رابط MP4 مباشر عبر HTTPS هو مصدر الوسائط المباشر المدعوم؛ لا تُقبل روابط WebM المباشرة كموفر خارجي. موصلات YouTube وInstagram وTikTok وVimeo وDailymotion وTwitch وFacebook تجريبية و**view-only**: التنفيذ لا يضمن تشغيل الرابط/الفيديو المحدد ولا full sync لها، وقد يمنع المزود التضمين.
- مزامنة `play` و`pause` و`seek`: المضيف هو صاحب التحكم، والمشاهد في وضع **view-only** ويتبع الحالة. لا يمكن للمشاهد تشغيل/إيقاف/تقديم الفيديو أو تغيير حالة الغرفة.
- رفع ملف محلي للمضيف حتى **2GB** (2,000,000,000 bytes) بصيغ MP4 أو WebM أو MPEG-TS (`.ts`, MIME `video/mp2t`). يفحص `ffprobe` المدة، ويحوّل TS عبر FFmpeg؛ MP4/WebM يُفحصان ثم يُحفظان كما هما.
- الترجمة المنفصلة VTT أو SRT (يوصى ألا تتجاوز 20MB) مع التحقق من البنية وتحويل SRT إلى VTT. حدّ `media-worker` الفعلي 20MB بعد الرفع/التنزيل؛ قد يقبل upload intent الحد العام أولاً ثم تفشل المعالجة إذا تجاوزت الترجمة 20MB. رابط playback الموقّع مدته 5 دقائق، وasset/upload/chat لها نافذة صلاحية ثلاث ساعات.
- محادثة Redis مؤقتة: 2,000 حرف، تاريخ حتى 100 رسالة، تنظيف HTML/محارف التحكم، وحذف الرسائل للمضيف.
- مؤتمر LiveKit: كاميرا، ميكروفون، مشاركة شاشة، وخيار صوت النظام. يبدأه المضيف؛ صلاحيات `canPublishAudio`, `canPublishVideo`, `canPublishScreen`, و`canSubscribe` تحدد ما يستطيع كل مشارك فعله. المشاهد لا يطلب صلاحية جهاز قبل الضغط، ولا يستطيع تشغيل جهاز شخص آخر قسراً.
- تحكم المضيف في منح/سحب صلاحيات المؤتمر، الكتم، والطرد، ونقل المضيف حيث تدعمه واجهة الغرفة/الخدمة. كتم المشاهدين محلي في واجهة المستمع، بينما إجراءات moderation الموجهة للمشارك للمضيف.
- سقف العرض المرئي في واجهة المؤتمر 6 مشاركين، مع تتبع LiveKit للوسائط المنشورة.

### full-sync مقابل view-only

`full-sync` هنا يعني أن المضيف يدير timeline الغرفة (تشغيل، إيقاف، وتقديم) وتصل
الأوامر للمشاركين؛ لا يعني مزامنة أجهزة المستخدم أو ضمان تطابق buffering والشبكة
لحظياً. المشاهدون view-only للتشغيل، لكنهم يستطيعون التحكم في كتم صوتهم/مستوى
صوتهم محلياً، وإدارة جهازهم إذا منحهم المضيف grant. لا توجد حالياً مساواة في
التحكم بين جميع المشاركين ولا مزامنة DRM أو الموصلات الاجتماعية التجريبية أو محتوى
YouTube المحظور تضمينه.

## المعمارية وتدفق البيانات

الخدمات المعرفة في `docker-compose.yml`:

| الخدمة | الدور |
| --- | --- |
| `web` | Next.js UI على 3000؛ يتصل بالـrealtime وبـLiveKit من المتصفح. |
| `realtime` | API وSocket.IO على 4000: الغرف، الحضور، playback events، chat، media intents، وLiveKit tokens. يشغّل Prisma migrations عند بدء Compose. |
| `postgres` | PostgreSQL 16 للغرف والمشاركين والـmedia assets والترجمات. |
| `redis` | قوائم chat ذات TTL وطابور وظائف `media-worker` المؤقت. لا يخزن الغرف أو المشاركين. |
| `minio` و`minio-init` | Object storage وتهيئة bucket `media`؛ worker وrealtime يصلان داخلياً، والـAPI يوقّع URLs. |
| `media-worker` | يستهلك الوظائف، يحد الحجم، يستعمل `ffprobe`/`ffmpeg`، يحوّل TS والترجمات وينظف المنتهي. |
| `livekit` | SFU للمؤتمر؛ image مثبتة digest، وbind على host network. |
| `coturn` | TURN relay على TCP وUDP في port 3478، مع relay range 30000–30010. إعداد المتصفح الحالي يطلب TURN عبر TCP فقط عبر `transport=tcp`. |

التدفق المعتاد: المتصفح يطلب token من `realtime`؛ تُحفظ حالة الغرفة في PostgreSQL
وتتبادل clients أحداث الغرفة عبر Socket.IO مباشرة من `realtime`؛ يرفع المضيف إلى
presigned MinIO URL ثم يضع worker المهمة ويحدّث asset؛ يطلب المتصفح playback URL؛
وللمؤتمر يصدر realtime token قصير العمر وICE servers، ثم يتصل المتصفح بـLiveKit/coturn
مباشرة. يُستخدم Redis للدردشة المؤقتة وطابور وظائف الوسائط فقط، وليس كطبقة presence
أو broadcast للغرفة.

## المتطلبات

- Node.js 20+ وnpm، وDocker Compose v2.
- Windows: Docker Desktop حديث مع Linux containers وPowerShell. يجب تفعيل **Host
  Networking** في Docker Desktop: Settings → Resources → Network → Enable host
  networking (ثم Apply/Restart)، إن كان الخيار متاحاً في إصدارك. Compose يستخدم
  `network_mode: host` لـLiveKit وcoturn عمداً؛ دون ذلك قد تفشل ICE/relay حتى لو كانت
  باقي الخدمات سليمة.
- Linux: Docker Engine/Compose v2، Bash، و`curl` لفحص الجاهزية؛ يستحسن `ip` و`ss`
  أو `lsof`. يجب أن يدعم المضيف host networking وأن تسمح firewall بالمنافذ المذكورة
  أدناه من الشبكة المطلوبة، خصوصاً 7880 وTCP/UDP 3478 و30000–30010، وإلا لن يعمل relay.
- المنافذ المحلية 3000 و4000 و7880 و3478 و9000 غير مشغولة. لا حاجة لفتح PostgreSQL
  أو Redis خارج شبكة Compose.

## الإعداد والأسرار

```bash
cp .env.example .env                 # PowerShell: Copy-Item .env.example .env
```

غيّر القيم السرية في `.env` المحلي: `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, و`TURN_SHARED_SECRET`. القيم الموجودة في
`.env.example` placeholders/تطوير فقط؛ لا تضع production secrets أو credentials في
Git أو README أو سجلات CI. احفظ `.env` خارج النسخ الاحتياطي العام ودوّرها عند
المشاركة. اترك `LIVEKIT_NODE_IP` و`DOCKER_HOST_NETWORK_IP` غير مضبوطين عادةً؛
السكربتان تكتشفان العناوين ديناميكياً. عند الفشل، اضبطهما إلى عناوين LAN/host-network
المناسبة محلياً فقط، ولا تثبّت عنواناً من بيئة أخرى في الوثائق.

إعدادات مهمة: `NEXT_PUBLIC_REALTIME_URL`, `REALTIME_ORIGINS`, `MINIO_PUBLIC_ORIGIN`,
`NEXT_PUBLIC_LIVEKIT_RELAY_ONLY=true`, `MEDIA_MAX_BYTES`، و`MEDIA_JOB_TIMEOUT_MS`.
القيمة Compose الافتراضية لحجم worker هي 2GB؛ لا ترفع الحد دون مراجعة التخزين
والـworker. `WATCH_WITH_ME_TIMEOUT` اختياري (120 ثانية افتراضياً).

> لا تحتاج عادةً إلى تشغيل `npm run prisma:generate` قبل Docker: صور Compose تولّد
> Prisma أثناء build، و`realtime` يطبق migrations عند الإقلاع. الأمر موجود فعلياً
> في `package.json` لمن يريد توليد عميل المضيف.

## Quick Start

### Windows PowerShell

```powershell
Copy-Item .env.example .env
npm install
.\scripts\watch-with-me.ps1 doctor
.\scripts\watch-with-me.ps1 start
```

افتح <http://127.0.0.1:3000/>. إذا منع PowerShell السكربت، اسمح لهذه الجلسة فقط:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
Unblock-File -Path .\scripts\watch-with-me.ps1
.\scripts\watch-with-me.ps1 start
```

لا تستخدم `Bypass` دائماً ولا تغيّر Execution Policy على مستوى الجهاز.

### Linux / Bash (أو Git Bash/WSL)

```bash
cp .env.example .env
npm install
chmod +x scripts/watch-with-me.sh
./scripts/watch-with-me.sh doctor
./scripts/watch-with-me.sh start
```

بعدها افتح <http://127.0.0.1:3000/>. من WSL/Git Bash تأكد أن `docker` يتصل بالـDocker
daemon الصحيح وأن host networking/firewall ينتميان إلى البيئة التي تشغّل Docker.

## مرجع أوامر السكربت

البادئة في Windows هي `.\scripts\watch-with-me.ps1` وفي Bash هي
`./scripts/watch-with-me.sh`. هذه هي الأوامر الفعلية في السكربتين:

| الأمر | السلوك والخيارات |
| --- | --- |
| `start [--no-build]` | `docker compose up -d`، أو `up --build -d` افتراضياً، ثم ينتظر الصحة. |
| `stop` | يوقف الحاويات دون حذفها أو volumes؛ بلا خيارات. |
| `restart [--no-build]` | stop ثم start؛ يقبل `--no-build`. |
| `status` | يعرض `docker compose ps`. |
| `health` | ينتظر صحة كل الخدمات واستجابة web. |
| `logs SERVICE [--follow] [--tail N]` | SERVICE واحد من `web`, `realtime`, `postgres`, `redis`, `minio`, `livekit`, `coturn`, `media-worker`؛ الذيل 100 افتراضياً. |
| `remove` | `down --remove-orphans`: يحذف containers/networks ويُبقي volumes. |
| `clean [--yes]` | `down --volumes --remove-orphans`؛ يتطلب كتابة `DELETE` أو `--yes` ويحذف بيانات volumes. |
| `test` | ينتظر الصحة ثم ينفذ `npm --prefix <root> run test:e2e:docker`. |
| `doctor` | يفحص Docker daemon وCompose و3000/4000 ولا يقتل أي process. |
| `config` | ينفذ `docker compose config` بعد preflight. |
| `help`, `-h`, `--help` | يعرض الاستخدام. |

أمثلة:

```bash
./scripts/watch-with-me.sh logs realtime --follow --tail 50
./scripts/watch-with-me.sh restart --no-build
```

## المنافذ والبروتوكولات والتعرض

| المنفذ | الخدمة/البروتوكول | التعرض المحلي |
| --- | --- | --- |
| 3000/tcp HTTP | web | منشور من Compose؛ واجهة المستخدم. |
| 4000/tcp HTTP/WebSocket | realtime | مربوط بـ`127.0.0.1`؛ health `/health/live` و`/health/ready`. |
| 9000/tcp HTTP | MinIO API | مربوط بـ`127.0.0.1`؛ لا تنشر console 9001 في Compose. |
| 7880/tcp HTTP/WebSocket | LiveKit signaling/API | host network؛ bind wildcard بسبب RTC، فاحمه بـfirewall. |
| 3478/tcp+udp TURN | coturn | host network؛ يستمع TCP وUDP، بينما يطلب browser URL الحالي TCP عبر `turn:...:3478?transport=tcp`. |
| 30000–30010 | coturn relay | host network؛ افتحها فقط للشبكة المطلوبة. |
| 7881/tcp و7882/udp | LiveKit RTC | يضبطها LiveKit؛ لا تضف mapping عشوائياً، وراجع firewall إذا استعملت direct ICE. |

PostgreSQL 5432 وRedis 6379 غير منشورين؛ يتصل بهما التطبيق عبر `backend` الداخلي.
في Docker Desktop، لا تفترض أن localhost وLAN في host network متطابقان: السكربت
يكتشف `LIVEKIT_NODE_IP` و`DOCKER_HOST_NETWORK_IP` ويحقنهما في Compose.

## استخدام الغرفة

1. افتح الصفحة الرئيسية أو `/create`، اكتب اسم العرض وأنشئ الغرفة.
2. اختر رابط MP4 مباشر عبر HTTPS، أو استخدم أحد الموصلات الاجتماعية التجريبية للعرض فقط، أو ارفع ملفاً محلياً بصيغة MP4/WebM/TS. الرفع للمضيف فقط، ثم انتظر `تجهيز الفيديو` حتى يصبح playback جاهزاً؛ لا تفترض أن الموصل التجريبي سيشغل الفيديو المحدد أو يزامنه.
3. أضف VTT/SRT إن كانت الواجهة/نقطة API متاحة، واختر اللغة؛ لا ترفع HTML أو روابط داخل ملف الترجمة.
4. انسخ رمز الغرفة/رابط الدعوة. افتح نافذة خاصة أو متصفحاً ثانياً، ادخل `/join` واستخدم اسماً مختلفاً.
5. المضيف يضغط تشغيل/إيقاف أو يغيّر timeline؛ المشاهدون يرون الحالة المتزامنة ويستطيعون كتم صوتهم محلياً فقط.
6. أرسل رسالة من Chat (Enter للإرسال وShift+Enter لسطر جديد). تاريخ chat مؤقت ثلاث ساعات، والمضيف يستطيع حذف الرسالة.
7. فعّل مؤتمر LiveKit من لوحة المضيف. امنح المشاهدين grant عند الحاجة؛ كل مشارك يضغط بنفسه للانضمام ويسمح للمتصفح بالكاميرا/الميكروفون.
8. شغّل الكاميرا أو الميكروفون، أو اختر `مشاركة الشاشة` وفعّل `مشاركة صوت النظام` قبل الطلب. يستطيع المضيف grant/revoke وmute/kick؛ غادر الفيديو دون مغادرة غرفة المشاهدة.
9. عند الحاجة إلى تسليم القيادة، استخدم host transfer في واجهة/خدمة الغرفة، ثم تحقّق أن المضيف الجديد يملك controls قبل خروج المضيف القديم.
10. للخروج، أغلق الغرفة/التبويب أو غادر المؤتمر؛ استخدم `stop` لإيقاف البيئة كاملة.

## الاختبارات والتطوير المحلي

### سكربتات npm الفعلية

`npm run dev` يشغل **web وrealtime فقط** محلياً. يتطلب PostgreSQL وRedis وMinIO
وLiveKit/coturn مهيأة وقابلة للوصول وفق `.env`؛ شغّل `media-worker` منفصلاً إذا أردت
معالجة الرفع/الترجمة. لا ينشئ هذا الأمر خدمات البنية التحتية تلقائياً.
والأوامر الأخرى هي: `npm run build`, `lint`, `typecheck`, `test`, `format`,
`format:check`, `prisma:generate`, `prisma:migrate`, `docker:config`, `docker:build`,
`docker:up`, `test:e2e`, `test:e2e:docker`, `test:e2e:qa`, و`test:e2e:qa:all`.

لا تشغّل `npm run dev` بالتوازي مع Compose: كلاهما يستخدم 3000/4000 وقد تتصل ببيئة
خاطئة. يوجد فصل واضح بين بوابات الاختبار:

- **Local gate:** `npm run lint && npm run typecheck && npm test && npm run build`.
- **Local Playwright:** `npm run test:e2e` يشغل web/realtime عبر `webServer` على
  `127.0.0.1`، وChromium افتراضياً؛ `PW_ALL_BROWSERS=1` يضيف Firefox/WebKit. أوقف
  Compose وأي dev servers/خدمات تستخدم 3000 أو 4000 قبل التشغيل؛ `reuseExistingServer`
  قد يعيد استخدام خدمة قائمة ويجعل الاختبار يتصل ببيئة خاطئة.
- **Docker gate:** بعد `start` شغّل `npm run test:e2e:docker` أو أمر السكربت `test`؛
  يستخدم `playwright.docker.config.ts` و`tests/e2e/docker.spec.ts` على
  `http://localhost:3000`، مع video وscreenshot عند الفشل (trace معطّل في إعداد Docker).
- `npm run test:all` **ليس** بوابة Docker ولا يشغّل `test:e2e:docker` أو QA؛ هو حرفياً
  `lint && typecheck && npm test && test:e2e && build`. لا تنسب إليه تغطية Compose.

لـREADME فقط، تحقق من التنسيق بـ`npm run format:check`؛ الأمر يفحص المشروع كله وقد
يكشف ملفات أخرى غير معدّلة. لا تشغّل `format` لأنه يكتب ملفات كثيرة.

## استكشاف الأخطاء

- **Docker غير متاح:** شغّل Docker Desktop/Engine، تأكد من Linux containers، ثم `doctor`.
- **Compose config يفشل:** نفّذ `config` من جذر المستودع، راجع `.env`، وتأكد أن
  `LIVEKIT_NODE_IP` و`DOCKER_HOST_NETWORK_IP` قابلان للاكتشاف أو مضبوطتان محلياً.
- **Windows وhost networking:** فعّل Docker Desktop Host Networking ثم Apply/Restart؛
  تحقق من أن خيار الإصدار مدعوم، ومن Windows Firewall وVPN وWSL لا تمنع 7880/3478/relay.
- **Linux وICE/TURN:** تحقق من `ip route`, `ss -ltnup`, قواعد firewall وNAT؛ اسمح
  TCP وUDP 3478 وTCP/UDP relay range 30000–30010، وراجع 7880/7881/7882 عند direct ICE. لا تستخدم عنواناً
  افتراضياً من شبكة أخرى.
- **health timeout:** زد `WATCH_WITH_ME_TIMEOUT=240`، ثم `status` و`logs postgres`
  و`redis` و`minio` و`livekit` و`coturn` و`media-worker` و`realtime` و`web`. لا تحذف
  volumes لمجرد timeout.
- **3000/4000 مشغولان:** `doctor` يحذر ولا يقتل processes؛ أوقف dev أو containers
  القديمة، ثم `status`. لا تستخدم `clean` لحل تعارض منفذ.
- **LiveKit لا يتصل:** راجع `LIVEKIT_NODE_IP`, `DOCKER_HOST_NETWORK_IP`, `TURN_SHARED_SECRET`
  والسجلات. في الوضع الافتراضي relay-only يجب أن يظهر `connectionType=relay` في
  Chrome WebRTC/LiveKit stats؛ لا تسجل tokens أو credentials.
- **الكاميرا/الميكروفون/الشاشة:** امنح browser permission، استخدم HTTPS أو localhost،
  تحقق من أن المضيف فعّل المؤتمر ومن grants؛ صوت النظام يعتمد على دعم المتصفح/OS.
- **رفع يفشل:** تحقق من MIME والامتداد والحجم ≤2GB، صحة MinIO و`media-worker`، ثم
  `logs media-worker`. مدة المعالجة محدودة بـ`MEDIA_JOB_TIMEOUT_MS`، وTS يحتاج FFmpeg.
- **الترجمة مرفوضة:** استخدم header `WEBVTT` لـVTT أو timestamps صحيحة لـSRT؛ أبقِها
  ≤20MB لأن `media-worker` يرفض الأكبر بعد الرفع/التنزيل، ولا تستخدم HTML/URLs. لا
  تخلط MIME الامتداد.
- **YouTube/موصل اجتماعي لا يعمل:** الموصلات تجريبية view-only ولا تضمن تشغيل الرابط
  أو الفيديو المحدد أو full sync؛ جرّب مصدراً يسمح بالتضمين، واعتبر قيود العمر/المنطقة/
  embed من المزود خارج سيطرة التطبيق.
- **PowerShell execution policy:** استخدم `-Scope Process` و`Unblock-File` أعلاه فقط.
- **Bash permission denied أو WSL:** `chmod +x scripts/watch-with-me.sh`، ثم تحقق من
  daemon والـfilesystem؛ شغّل Bash عبر Git Bash/WSL المناسب لا shell غير متوافق.

## الإيقاف والتنظيف

- `stop`: إيقاف مؤقت، يبقي containers وvolumes.
- `remove`: يحذف containers/networks/orphans، ويبقي PostgreSQL/Redis/MinIO volumes.
- `clean` أو `clean --yes`: يحذف containers/networks وvolumes؛ يمسح بيانات PostgreSQL
  وRedis وMinIO نهائياً ولا يمكن التراجع عنه. خذ نسخة احتياطية وتحقق من المشروع قبل
  تأكيد `DELETE` أو استعمال `--yes`. لا يحذف images/cache.

## الأمان والخصوصية والإتاحة وSEO

- استخدم TLS وsecrets manager وfirewall وTURN credentials قصيرة العمر في الإنتاج؛
  `ALLOW_INSECURE_LOCAL_MEDIA=true` وبيانات MinIO الافتراضية للتطوير المحلي فقط.
- presigned upload/playback، التحقق من MIME/extension/size، ffprobe، تنظيف chat وTTL
  تقلل المخاطر لكنها ليست بديلاً عن عزل التخزين والـrate limiting والمراقبة.
- لا تسجل access tokens أو URLs الموقعة أو مفاتيح LiveKit/TURN. راجع سياسة الاحتفاظ:
  chat/assets/subtitles مؤقتة، وvolumes الدائمة تحتاج حذفاً مقصوداً.
- الواجهة تستخدم labels وARIA live/log وkeyboard-friendly controls وحالات alert؛
  اختبر التركيز، captions، إذن الأجهزة، contrast، وscreen reader قبل التغيير.
- Next يوفّر `sitemap` و`robots` وmetadata؛ حافظ على عناوين صفحات فريدة، روابط دعوة
  غير مفهرسة عند اللزوم، وHTTPS/canonical وalt/labels. لا تكشف رموز الغرف أو بيانات
  المشاركين في صفحات عامة.
- سجل الاستثناءات المؤقتة ومراجعتها في
  [`docs/security-exceptions.md`](docs/security-exceptions.md)، وتنتهي/تُراجع في
  **2026-12-16**؛ لا تستخدم `npm audit fix --force` أو ترقية major دون مراجعة.

## قائمة نشر

- [ ] استبدال كل مفاتيح development وتدويرها، وتفعيل TLS وsecure origins.
- [ ] تعطيل `ALLOW_INSECURE_LOCAL_MEDIA`، وضبط CORS/origins وقواعد firewall وTURN/NAT.
- [ ] عدم تعريض PostgreSQL/Redis/MinIO console للإنترنت؛ عزل object storage وتفعيل
  retention/backup ومراقبة worker.
- [ ] تثبيت ومراجعة images/dependencies، تشغيل lint/typecheck/unit/build وLocal E2E
  وDocker E2E وQA المطلوبة؛ لا اعتبار `test:all` بوابة Docker.
- [ ] اختبار host transfer، view-only، moderation، uploads/FFmpeg/VTT/SRT، grants،
  screen/system audio، accessibility، المتصفحات والشبكات الفعلية.
- [ ] مراجعة `docs/security-exceptions.md` قبل **2026-12-16** أو عند ظهور trigger،
  وتوثيق قرار كل استثناء قبل الإطلاق.
