#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define MAX_FRAMES 24
#define STACK_CAP (1u << 16)
#define LIVE_CAP (1u << 22)

static void *(*real_malloc)(size_t);
static void (*real_free)(void *);
static void *(*real_calloc)(size_t, size_t);
static void *(*real_realloc)(void *, size_t);
static int (*real_posix_memalign)(void **, size_t, size_t);

static __thread int in_hook __attribute__((tls_model("initial-exec")));
static __thread size_t since_sample __attribute__((tls_model("initial-exec")));

static size_t big_threshold = 32768;
static size_t sample_interval = 1u << 20;
static int armed;

struct stack_entry {
  uint64_t hash;
  int depth;
  void *frames[MAX_FRAMES];
  uint64_t big_bytes;
  uint64_t big_count;
  uint64_t sampled_count;
};

struct live_entry {
  void *ptr;
  size_t size;
  uint32_t stack;
  uint32_t kind;
};

static struct stack_entry *stacks;
static struct live_entry *live;
static volatile int lock;

static char bootstrap[1 << 20];
static size_t bootstrap_used;

static void take_lock(void) {
  while (__sync_lock_test_and_set(&lock, 1)) {
    while (lock) __asm__ __volatile__("" ::: "memory");
  }
}
static void drop_lock(void) { __sync_lock_release(&lock); }

static uint32_t intern_stack(void *const *frames, int depth) {
  uint64_t h = 1469598103934665603ULL;
  for (int i = 0; i < depth; i++) {
    h ^= (uint64_t)(uintptr_t)frames[i];
    h *= 1099511628211ULL;
  }
  uint32_t idx = (uint32_t)(h & (STACK_CAP - 1));
  for (uint32_t probe = 0; probe < STACK_CAP; probe++) {
    uint32_t i = (idx + probe) & (STACK_CAP - 1);
    if (stacks[i].hash == 0) {
      stacks[i].hash = h ? h : 1;
      stacks[i].depth = depth;
      memcpy(stacks[i].frames, frames, (size_t)depth * sizeof(void *));
      return i;
    }
    if (stacks[i].hash == h) return i;
  }
  return 0;
}

static uint32_t live_slot(void *p) {
  uint64_t h = (uint64_t)(uintptr_t)p;
  h ^= h >> 33;
  h *= 0xff51afd7ed558ccdULL;
  h ^= h >> 33;
  return (uint32_t)(h & (LIVE_CAP - 1));
}

static void live_insert(void *p, size_t size, uint32_t stack, uint32_t kind) {
  uint32_t idx = live_slot(p);
  for (uint32_t probe = 0; probe < 256; probe++) {
    uint32_t i = (idx + probe) & (LIVE_CAP - 1);
    if (live[i].ptr == NULL) {
      live[i].ptr = p;
      live[i].size = size;
      live[i].stack = stack;
      live[i].kind = kind;
      return;
    }
  }
}

static int live_remove(void *p, struct live_entry *out) {
  uint32_t idx = live_slot(p);
  for (uint32_t probe = 0; probe < 256; probe++) {
    uint32_t i = (idx + probe) & (LIVE_CAP - 1);
    if (live[i].ptr == p) {
      *out = live[i];
      live[i].ptr = NULL;
      return 1;
    }
  }
  return 0;
}

static void note(void *p, size_t size) {
  if (!armed || p == NULL) return;
  uint32_t kind;
  if (size >= big_threshold) {
    kind = 1;
  } else {
    since_sample += size;
    if (since_sample < sample_interval) return;
    since_sample = 0;
    kind = 2;
  }
  in_hook = 1;
  void *frames[MAX_FRAMES];
  int depth = backtrace(frames, MAX_FRAMES);
  take_lock();
  uint32_t s = intern_stack(frames, depth);
  live_insert(p, size, s, kind);
  drop_lock();
  in_hook = 0;
}

static void unnote(void *p) {
  if (!armed || p == NULL) return;
  struct live_entry e;
  take_lock();
  live_remove(p, &e);
  drop_lock();
}

static void dump(int sig) {
  (void)sig;
  in_hook = 1;
  const char *out = getenv("HEAPLOG_OUT");
  if (!out) return;
  char path[512];
  snprintf(path, sizeof(path), "%s.%d", out, getpid());
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return;
  take_lock();
  for (uint32_t i = 0; i < STACK_CAP; i++) {
    stacks[i].big_bytes = 0;
    stacks[i].big_count = 0;
    stacks[i].sampled_count = 0;
  }
  uint64_t big_total = 0, sampled = 0;
  for (uint32_t i = 0; i < LIVE_CAP; i++) {
    if (live[i].ptr == NULL) continue;
    struct stack_entry *s = &stacks[live[i].stack];
    if (live[i].kind == 1) {
      s->big_bytes += live[i].size;
      s->big_count += 1;
      big_total += live[i].size;
    } else {
      s->sampled_count += 1;
      sampled += 1;
    }
  }
  char buf[4096];
  FILE *mf = fopen("/proc/self/maps", "r");
  if (mf) {
    char line[1024];
    while (fgets(line, sizeof(line), mf)) {
      if (strstr(line, " r-xp ") && strstr(line, "/deno")) {
        int n = snprintf(buf, sizeof(buf), "EXEMAP %s", line);
        ssize_t w = write(fd, buf, (size_t)n); (void)w;
        break;
      }
    }
    fclose(mf);
  }
  int n = snprintf(buf, sizeof(buf),
                   "BIGTHRESH %zu\nINTERVAL %zu\nLIVEBIG %llu\nLIVESAMPLES %llu\n",
                   big_threshold, sample_interval,
                   (unsigned long long)big_total, (unsigned long long)sampled);
  ssize_t w = write(fd, buf, (size_t)n); (void)w;
  for (uint32_t i = 0; i < STACK_CAP; i++) {
    struct stack_entry *s = &stacks[i];
    if (s->hash == 0) continue;
    if (s->big_bytes == 0 && s->sampled_count == 0) continue;
    n = snprintf(buf, sizeof(buf), "STACK bigbytes=%llu bigcount=%llu samples=%llu\n",
                 (unsigned long long)s->big_bytes, (unsigned long long)s->big_count,
                 (unsigned long long)s->sampled_count);
    w = write(fd, buf, (size_t)n); (void)w;
    for (int f = 0; f < s->depth; f++) {
      n = snprintf(buf, sizeof(buf), "  %p\n", s->frames[f]);
      w = write(fd, buf, (size_t)n); (void)w;
    }
  }
  drop_lock();
  close(fd);
  in_hook = 0;
}

__attribute__((constructor)) static void init(void) {
  real_malloc = dlsym(RTLD_NEXT, "malloc");
  real_free = dlsym(RTLD_NEXT, "free");
  real_calloc = dlsym(RTLD_NEXT, "calloc");
  real_realloc = dlsym(RTLD_NEXT, "realloc");
  real_posix_memalign = dlsym(RTLD_NEXT, "posix_memalign");
  const char *b = getenv("HEAPLOG_BIG");
  if (b) big_threshold = (size_t)strtoull(b, NULL, 10);
  const char *iv = getenv("HEAPLOG_INTERVAL");
  if (iv) sample_interval = (size_t)strtoull(iv, NULL, 10);
  if (!getenv("HEAPLOG_OUT")) return;
  stacks = mmap(NULL, sizeof(struct stack_entry) * STACK_CAP, PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  live = mmap(NULL, sizeof(struct live_entry) * LIVE_CAP, PROT_READ | PROT_WRITE,
              MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (stacks == MAP_FAILED || live == MAP_FAILED) return;
  signal(SIGUSR1, dump);
  armed = 1;
}

void *malloc(size_t size) {
  if (!real_malloc) {
    size_t a = (size + 15) & ~(size_t)15;
    if (bootstrap_used + a > sizeof(bootstrap)) return NULL;
    void *p = bootstrap + bootstrap_used;
    bootstrap_used += a;
    return p;
  }
  void *p = real_malloc(size);
  if (!in_hook) note(p, size);
  return p;
}

void free(void *p) {
  if (p >= (void *)bootstrap && p < (void *)(bootstrap + sizeof(bootstrap))) return;
  if (!in_hook) unnote(p);
  if (real_free) real_free(p);
}

void *calloc(size_t n, size_t size) {
  if (!real_calloc) {
    size_t total = n * size;
    size_t a = (total + 15) & ~(size_t)15;
    if (bootstrap_used + a > sizeof(bootstrap)) return NULL;
    void *p = bootstrap + bootstrap_used;
    bootstrap_used += a;
    memset(p, 0, total);
    return p;
  }
  void *p = real_calloc(n, size);
  if (!in_hook) note(p, n * size);
  return p;
}

void *realloc(void *old, size_t size) {
  if (!real_realloc) return NULL;
  if (!in_hook) unnote(old);
  void *p = real_realloc(old, size);
  if (!in_hook) note(p, size);
  return p;
}

int posix_memalign(void **out, size_t align, size_t size) {
  if (!real_posix_memalign) return 12;
  int r = real_posix_memalign(out, align, size);
  if (r == 0 && !in_hook) note(*out, size);
  return r;
}
