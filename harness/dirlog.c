#define _GNU_SOURCE
#include <dlfcn.h>
#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <time.h>
static long t0;

static DIR *(*real_opendir)(const char *);
static int logfd = -1;

__attribute__((constructor)) static void init(void) {
  real_opendir = dlsym(RTLD_NEXT, "opendir");
  const char *o = getenv("DIRLOG_OUT");
  if (!o) return;
  char p[512];
  snprintf(p, sizeof(p), "%s.%d", o, getpid());
  logfd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0644);
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  t0 = ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

DIR *opendir(const char *n) {
  if (logfd >= 0 && n) {
    char buf[520];
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    long ms = ts.tv_sec * 1000L + ts.tv_nsec / 1000000L - t0;
    int k = snprintf(buf, sizeof(buf), "%ld %s\n", ms, n);
    if (k > 0) { ssize_t r = write(logfd, buf, k); (void)r; }
  }
  return real_opendir(n);
}
