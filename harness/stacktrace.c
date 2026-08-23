#define _GNU_SOURCE
#include <dlfcn.h>
#include <dirent.h>
#include <execinfo.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>

#define MAXF 40
#define MAXS 1024

static DIR *(*real_opendir)(const char *) = NULL;
static void *stacks[MAXS][MAXF];
static int depths[MAXS];
static long counts[MAXS];
static char sample[MAXS][256];
static int nstacks = 0;
static long total = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static __thread int in_hook = 0;
static const char *match = NULL;
static const char *outpath = NULL;

static void dump(void);

__attribute__((constructor)) static void st_init(void) {
  real_opendir = dlsym(RTLD_NEXT, "opendir");
  match = getenv("ST_MATCH");
  outpath = getenv("ST_OUT");
  if (!outpath) outpath = "/tmp/stacktrace.txt";
}

static void dump(void) {
  char p[512];
  snprintf(p, sizeof(p), "%s.%d", outpath, getpid());
  FILE *f = fopen(p, "w");
  if (!f) return;
  FILE *m = fopen("/proc/self/maps", "r");
  if (m) {
    char line[2048];
    while (fgets(line, sizeof(line), m)) {
      if (strstr(line, "r-xp") && strstr(line, "/deno") && !strstr(line, ".so")) {
        fprintf(f, "EXEMAP %s", line);
        break;
      }
    }
    fclose(m);
  }
  fprintf(f, "TOTAL %ld\n", total);
  for (int i = 0; i < nstacks; i++) {
    fprintf(f, "STACK %ld %s\n", counts[i], sample[i]);
    for (int j = 0; j < depths[i]; j++) fprintf(f, "  %p\n", stacks[i][j]);
  }
  fclose(f);
}

__attribute__((destructor)) static void st_fini(void) { dump(); }

DIR *opendir(const char *name) {
  if (!real_opendir) real_opendir = dlsym(RTLD_NEXT, "opendir");
  if (!in_hook && name && (!match || !*match || strstr(name, match))) {
    in_hook = 1;
    void *bt[MAXF];
    int d = backtrace(bt, MAXF);
    pthread_mutex_lock(&lock);
    total++;
    int found = -1;
    for (int i = 0; i < nstacks; i++)
      if (depths[i] == d && memcmp(stacks[i], bt, d * sizeof(void *)) == 0) { found = i; break; }
    if (found >= 0) {
      counts[found]++;
      if (counts[found] % 4096 == 0) dump();
    } else if (nstacks < MAXS) {
      memcpy(stacks[nstacks], bt, d * sizeof(void *));
      depths[nstacks] = d;
      counts[nstacks] = 1;
      snprintf(sample[nstacks], sizeof(sample[nstacks]), "%s", name);
      nstacks++;
      dump();
    }
    pthread_mutex_unlock(&lock);
    in_hook = 0;
  }
  return real_opendir(name);
}
