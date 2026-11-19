#include <bits/stdc++.h>
using namespace std;
void fuc(int* p)
{
    *p = 100;
}

int main()
{
    vector<int> a(100, -1);
    for (int i = 10; i < 100; ++i)
    {
        fuc(&a[i]);
    }
    for (int i = 0; i < 100; ++i)
    {
        cout << a[i] << " ";
    }
}