#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#endif

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  errno = 0;
  long n = strtol(argv[1], &end, 10);
  if (errno || !end || *end || n <= 0 || n > INT_MAX) return 2;
#ifdef __APPLE__
  char path[PROC_PIDPATHINFO_MAXSIZE];
  int size = proc_pidpath((int)n, path, sizeof(path));
  if (size <= 0 || size >= (int)sizeof(path)) return 1;
#else
  char path[PATH_MAX], proc[64];
  snprintf(proc, sizeof(proc), "/proc/%ld/exe", n);
  ssize_t size = readlink(proc, path, sizeof(path) - 1);
  if (size <= 0 || size >= (ssize_t)sizeof(path) - 1) return 1;
  path[size] = '\0';
#endif
  return puts(path) < 0 ? 1 : 0;
}
