#pragma once

#include <stdint.h>

typedef struct {
    uint8_t year;
    uint8_t month;
    uint8_t day;
    uint8_t dayOfWeek;
    uint8_t hour;
    uint8_t minute;
    uint8_t second;
    uint8_t status;
    uint8_t alarmHour;
    uint8_t alarmMinute;
} SiiRtcInfo;

int payload_probe(void);
int payload_reset(void);
int payload_getstatus(SiiRtcInfo *info);
int payload_gettimedate(SiiRtcInfo *info);
void fake_rtc_menu_run_runtime(void);
