# Watch With Me

تطبيق TypeScript monorepo (يتطلب Node.js 20 أو أحدث) لإنشاء غرف مشاهدة متزامنة.
PostgreSQL هو مصدر البيانات الدائم، وRedis للحالة الحية والحضور. التشغيل الموصى به
للتجربة المحلية هو Docker Compose عبر scripts التشغيل أدناه.

## المتطلبات (Prerequisites)

- Docker Desktop (Windows/macOS) أو Docker Engine مع Docker Compose v2 (Linux).
- Node.js 20+ وnpm؛ يلزم npm فقط لأوامر تثبيت الحزم والاختبارات.
- على Linux: Bash و`curl` لفحص جاهزية HTTP (ويُستحسن `ss` أو `lsof` لأمر `doctor`).
- المنفذان المحليان 3000 (web) و4000 (realtime) متاحان.

شغّل Docker Desktop وانتظر حتى يظهر أنه يعمل قبل تشغيل أي أمر. تتحقق scripts من Docker
daemon ومن صحة `docker-compose.yml` تلقائياً.

## Quick start — Windows (PowerShell)

من جذر المشروع:

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
.\scripts\watch-with-me.ps1 start
```

بعد الجاهزية افتح [http://127.0.0.1:3000/](http://127.0.0.1:3000/). إذا منع PowerShell
تشغيل ملف السكربت، لا تستخدم `Bypass` دائماً. اسمح به لهذه الجلسة فقط:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
Unblock-File -Path .\scripts\watch-with-me.ps1
.\scripts\watch-with-me.ps1 start
```

ينتهي أثر `Scope Process` بإغلاق نافذة PowerShell. نفّذ `Unblock-File` فقط لملف المشروع
الموثوق، ولا تغيّر Execution Policy على مستوى الجهاز لمجرد تشغيل هذا السكربت.

## Quick start — Linux

```bash
cp .env.example .env
npm install
npm run prisma:generate
chmod +x scripts/watch-with-me.sh
./scripts/watch-with-me.sh start
```

افتح [http://127.0.0.1:3000/](http://127.0.0.1:3000/). المتغير الاختياري
`WATCH_WITH_ME_TIMEOUT` يحدد مهلة الانتظار بالثواني (الافتراضي `120`).

## Docker command reference

السكريبتان `scripts/watch-with-me.ps1` و`scripts/watch-with-me.sh` يقبلان الأوامر التالية
حرفياً. في Windows استخدم البادئة
`.\scripts\watch-with-me.ps1` (من دون مسافة قبل الأمر؛ الصيغة الصحيحة موضحة في الأمثلة)، وفي
Linux استخدم `./scripts/watch-with-me.sh`.

<!-- prettier-ignore -->
| Command | الوظيفة والخيارات الفعلية |
| --- | --- |
| `start` | يبني الصور ثم يشغّل الخدمات في الخلفية (`docker compose up --build -d`) وينتظر الجاهزية. يقبل `--no-build`. |
| `stop` | يوقف الحاويات فقط؛ لا يحذفها ولا يحذف البيانات. لا يقبل خيارات. |
| `restart` | ينفذ stop ثم يشغّل الخدمات، مع build افتراضياً؛ يقبل `--no-build`. |
| `status` | يعرض `docker compose ps`. |
| `health` | ينتظر صحة `postgres`, `redis`, `realtime`, `web` واستجابة web، بمهلة 120 ثانية افتراضياً. |
| `logs SERVICE` | يعرض آخر 100 سطر لخدمة واحدة فقط: `web` أو `realtime` أو `postgres` أو `redis`. |
| `remove` | ينفذ `docker compose down --remove-orphans`: يحذف الحاويات والشبكات، لا volumes. |
| `clean` | ينفذ `docker compose down --volumes --remove-orphans` بعد تأكيد `DELETE`؛ يقبل `--yes`. يحذف حاويات وشبكات وvolumes المشروع، فيترك Docker بلا موارد Compose لهذه البيئة (ولا يحذف images أو cache). |
| `test` | ينتظر الجاهزية ثم يشغّل `npm --prefix <root> run test:e2e:docker`؛ هذا هو Docker E2E الحقيقي. |
| `doctor` | يفحص Docker والـdaemon وCompose وتعارض 3000/4000، ولا يقتل أي process. |
| `help` | يعرض قائمة الاستخدام. ويدعم أيضاً `-h` و`--help`. |
| `config` | يتحقق من Compose ثم يعرض ناتج `docker compose config`. |

أمثلة:

```bash
./scripts/watch-with-me.sh status
./scripts/watch-with-me.sh logs web
./scripts/watch-with-me.sh logs realtime --follow
./scripts/watch-with-me.sh logs postgres --tail 200
./scripts/watch-with-me.sh restart --no-build
./scripts/watch-with-me.sh remove
```

في PowerShell نفس الأوامر بامتداد السكربت:

```powershell
.\scripts\watch-with-me.ps1 logs web
.\scripts\watch-with-me.ps1 logs realtime --follow --tail 50
```

### stop vs remove vs clean

- **stop**: إيقاف مؤقت؛ يمكن إعادة التشغيل بـ`start` أو `restart`، والبيانات تبقى.
- **remove**: إزالة الحاويات والشبكات (مع `--remove-orphans`) مع إبقاء volumes.
- **clean**: إزالة الحاويات والشبكات وvolumes؛ وهذا يمسح بيانات PostgreSQL وRedis.
  استخدمه فقط لإعادة ضبط البيئة. الوضع التفاعلي يتطلب كتابة `DELETE` حرفياً، أو
  استخدم `clean --yes` عندما تكون متأكداً. لا يمكن التراجع عن حذف البيانات من volume.

## Health URLs

- Web: [http://127.0.0.1:3000/](http://127.0.0.1:3000/)
- Realtime liveness: [http://127.0.0.1:4000/health/live](http://127.0.0.1:4000/health/live)
- Realtime readiness: [http://127.0.0.1:4000/health/ready](http://127.0.0.1:4000/health/ready)

## تجربة YouTube بمستخدمين

1. افتح `/create` أو الصفحة الرئيسية، أدخل اسم العرض، وأنشئ غرفة.
2. في الغرفة أدخل رابط الاختبار
   [https://www.youtube.com/watch?v=3QM6MvvGwTg](https://www.youtube.com/watch?v=3QM6MvvGwTg)
   كمصدر YouTube، ثم احتفظ برمز الغرفة/رابط الدعوة.
3. افتح نافذة خاصة أو متصفحاً ثانياً، ادخل `/join`، واستخدم رمز الغرفة واسماً مختلفاً.
4. اختبر التشغيل والإيقاف والتزامن بين النافذتين.

قد يمنع YouTube تشغيل بعض المقاطع داخل iframe بسبب **embed restrictions** التي يحددها
مالك الفيديو أو YouTube (مثل تعطيل التضمين أو قيود المنطقة/العمر). هذا لا يعني أن Docker
أو الغرفة معطّلان؛ جرّب فيديو يسمح بالتضمين. التطبيق لا ينزّل الوسائط ولا يعمل proxy لها.

## لا تشغّل dev مع Docker

لا تشغّل `npm run dev` بالتوازي مع Docker Compose: كلاهما يحاول استخدام 3000 للـweb
و4000 للـrealtime، وقد ينتج تعارض منافذ أو اتصالاً بخدمة مختلفة. اختر مساراً واحداً:
Docker عبر `start`، أو التطوير المحلي عبر `npm run dev` بعد تجهيز PostgreSQL وRedis
وفق إعدادات `.env`.

إذا ظهر تعارض 3000/4000، أوقف المسار الآخر أولاً، ثم شغّل:

```bash
./scripts/watch-with-me.sh doctor
```

على Windows:

```powershell
.\scripts\watch-with-me.ps1 doctor
```

سيحذر `doctor` إذا كان المنفذ منشوراً من حاوية أو مشغولاً من process على الجهاز، لكنه
لا يقتل أي process. افحص `status` و`logs web` و`logs realtime` بعد ذلك.

## الاختبارات

`test` في كلا scriptَي التشغيل (PowerShell وBash) هو أمر Docker E2E الحقيقي من طرف إلى
طرف؛ فهو ينتظر أن تكون خدمات Compose سليمة ثم يستدعي حرفياً
`npm --prefix <root> run test:e2e:docker` (أي `npm run test:e2e:docker` من جذر المشروع). هذا
المفتاح موجود حالياً ويشغّل Playwright Chromium بإعداد Docker على
`http://localhost:3000` (وهو الـdefault بسبب تطابق الـorigin؛ لا تستبدله تلقائياً بـ
`127.0.0.1` للاختبار)، ويختبر فعلياً مستخدم host ومستخدم viewer مستقلين: إنشاء الغرفة،
رابط الدعوة، تحميل فيديو YouTube ذي المعرّف `3QM6MvvGwTg`، ثم مزامنة التشغيل والإيقاف
والتقديم (`play`/`pause`/`seek`). يسجل Playwright trace/video عند الفشل؛ وإذا تعذر
YouTube أو الـiframe بسبب الاعتماد الخارجي، ينجح الاختبار في فحوص مزامنة حالة التطبيق
ثم يتخطى فحص الـembed برسالة توضح السبب. لذلك لا يضمن الاختبار توفر YouTube دائماً.

لتشغيله مباشرة بعد `start`:

```powershell
.\scripts\watch-with-me.ps1 test
```

```bash
./scripts/watch-with-me.sh test
```

للاختبارات الموجودة حالياً:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Troubleshooting

- **Docker CLI/daemon unavailable**: شغّل Docker Desktop (أو Docker Engine على Linux)،
  ثم أعد `doctor`.
- **Compose invalid/unavailable**: نفّذ `docker compose config` وتحقق من أنك في جذر
  المشروع وأن `docker-compose.yml` موجود.
- **الخدمات لا تصبح healthy**: نفّذ `status` ثم `logs postgres`, `logs redis`,
  `logs realtime`, و`logs web`. يمكن زيادة المهلة، مثلاً `WATCH_WITH_ME_TIMEOUT=240`.
- **المنفذ مستخدم**: اتبع فحص `doctor` أعلاه، وأوقف التطبيق المحلي أو الحاويات القديمة؛
  لا تحذف volumes لحل تعارض منفذ.
- **PowerShell execution policy**: استخدم إعداد `-Scope Process` و`Unblock-File` أعلاه،
  وليس `Bypass` دائمًا.
- **Linux permission denied**: نفّذ `chmod +x scripts/watch-with-me.sh` ثم أعد الأمر.
- **YouTube لا يعمل**: تحقّق من رابط HTTPS ومن السماح بالتضمين؛ قيود المالك لا تُحل
  بإعادة بناء Docker.

### LiveKit ICE وTURN محلياً

يعمل LiveKit وcoturn في Compose باستخدام `network_mode: host`؛ يكتشف السكربت
`LIVEKIT_NODE_IP` ويستخدمه LiveKit كعنوان LAN المعلن. يكتشف السكربت أيضاً
`DOCKER_HOST_NETWORK_IP` من namespace الخاص بـDocker Desktop ويستخدمه coturn
كـ`relay-ip` المحلي، مع mapping بصيغة `external-ip=LAN/VM`. يبقى signaling على
`127.0.0.1:7880`، ويصل المتصفح إلى coturn عبر `turn:localhost:3478?transport=tcp`.
لا تُنشر منافذ RTC أو relay ranges منفصلة؛ يستخدم coturn REST auth عبر
`TURN_SHARED_SECRET` ونطاق relay محدوداً `30000-30010`. لا يستخدم LiveKit
الـembedded TURN، بينما realtime داخل Docker يصل LiveKit عبر
`host.docker.internal:7880`.
Host networking requires LiveKit's bind address to be wildcard for RTC; therefore
`7880` is not independently loopback-bound by Compose. Restrict host access with
the existing LAN/host firewall policy rather than changing it in these scripts.
يصل المتصفح إلى `turn:localhost:3478?transport=tcp`، ويحصل على credentials
قصيرة العمر من realtime بعد إصدار access token. لا تُسجّل credentials ولا تُضمّن
في إعدادات ثابتة.

إذا فشل الاتصال، شغّل `doctor` ثم تحقق من سجل `coturn` و`livekit` ومن أن
coturn يملك عنواناً واحداً على شبكة `backend`. الإثبات النهائي يكون من Chrome
عبر `RTCPeerConnection`/LiveKit stats، حيث يجب أن تكون `connectionType` هي
`relay` عند استخدام relay-only.

لحذف كل بيانات البيئة عمداً، راجع الحالة أولاً، ثم نفّذ الأمر المناسب وأكّد المخاطر:

```bash
./scripts/watch-with-me.sh status
./scripts/watch-with-me.sh clean
# اكتب DELETE حرفياً عند الطلب
```

أو استخدم `clean --yes` فقط بعد أخذ نسخة احتياطية والتأكد من أنك تريد حذف PostgreSQL
وRedis volumes نهائياً.
