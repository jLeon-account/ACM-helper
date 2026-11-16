#include <iostream>
using namespace std;
long long factorial(int n) {
    long long answer = 1;
    if (n > 1) answer = n * factorial(n - 1);
    return answer;
}
int main() {
    int n;
    cin >> n;
    cout << factorial(n) << '\n';
    return 0;
}
