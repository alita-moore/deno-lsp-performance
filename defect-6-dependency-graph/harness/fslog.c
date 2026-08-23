#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <time.h>
#include <dirent.h>

static long t0;
static int logfd = -1;

static int (*real_open)(const char *, int, ...);
static int (*real_open64)(const char *, int, ...);
static int (*real_openat)(int, const char *, int, ...);
static int (*real_openat64)(int, const char *, int, ...);
static DIR *(*real_opendir)(const char *);

__attribute__((constructor)) static void init(void) {
  real_open = dlsym(RTLD_NEXT, "open");
  real_open64 = dlsym(RTLD_NEXT, "open64");
  real_openat = dlsym(RTLD_NEXT, "openat");
  real_openat64 = dlsym(RTLD_NEXT, "openat64");
  real_opendir = dlsym(RTLD_NEXT, "opendir");
  const char *o = getenv("FSLOG_OUT");
  if (!o) return;
  char p[512];
  snprintf(p, sizeof(p), "%s.%d", o, getpid());
  logfd = real_open64(p, O_WRONLY | O_CREAT | O_APPEND, 0644);
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  t0 = ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static void record(char kind, const char *n) {
  if (logfd < 0 || !n) return;
  char buf[4200];
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  long ms = ts.tv_sec * 1000L + ts.tv_nsec / 1000000L - t0;
  int k = snprintf(buf, sizeof(buf), "%ld %c %s\n", ms, kind, n);
  if (k > 0) { ssize_t r = write(logfd, buf, k > (int)sizeof(buf) ? (int)sizeof(buf) : k); (void)r; }
}

int open(const char *n, int fl, ...) {
  mode_t m = 0;
  if (fl & O_CREAT) { va_list a; va_start(a, fl); m = va_arg(a, mode_t); va_end(a); }
  record('F', n);
  return real_open(n, fl, m);
}

int open64(const char *n, int fl, ...) {
  mode_t m = 0;
  if (fl & O_CREAT) { va_list a; va_start(a, fl); m = va_arg(a, mode_t); va_end(a); }
  record('F', n);
  return real_open64(n, fl, m);
}

int openat(int d, const char *n, int fl, ...) {
  mode_t m = 0;
  if (fl & O_CREAT) { va_list a; va_start(a, fl); m = va_arg(a, mode_t); va_end(a); }
  record('F', n);
  return real_openat(d, n, fl, m);
}

int openat64(int d, const char *n, int fl, ...) {
  mode_t m = 0;
  if (fl & O_CREAT) { va_list a; va_start(a, fl); m = va_arg(a, mode_t); va_end(a); }
  record('F', n);
  return real_openat64(d, n, fl, m);
}

DIR *opendir(const char *n) {
  record('D', n);
  return real_opendir(n);
}
