#include "InterpDelay.hpp"

float sdramData[13][37000];
//float sdramData[50][72000];  // 72000 hit something bad
unsigned int count = 0;
bool triggerClear;
float clearPopCancelValue = 1.;
float hold = 1.;