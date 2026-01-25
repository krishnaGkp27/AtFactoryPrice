import 'package:flutter/foundation.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';

/// Reward Points Service
class PointsService extends ChangeNotifier {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseFunctions _functions = FirebaseFunctions.instance;
  
  Map<String, dynamic>? _wallet;
  List<Map<String, dynamic>> _transactions = [];
  bool _isLoading = false;
  String? _error;
  
  Map<String, dynamic>? get wallet => _wallet;
  List<Map<String, dynamic>> get transactions => _transactions;
  bool get isLoading => _isLoading;
  String? get error => _error;
  
  int get totalPoints => _wallet?['totalPointsEarned'] ?? 0;
  int get availablePoints => _wallet?['availablePoints'] ?? 0;
  int get pendingPoints => _wallet?['pendingPoints'] ?? 0;
  int get redeemedPoints => _wallet?['redeemedPoints'] ?? 0;
  
  Future<void> loadWallet(String userId) async {
    if (userId.isEmpty) return;
    
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();
      
      final walletDoc = await _firestore
        .collection('mlm_points_wallet')
        .doc(userId)
        .get();
      
      if (walletDoc.exists) {
        _wallet = walletDoc.data();
      } else {
        _wallet = {
          'totalPointsEarned': 0,
          'availablePoints': 0,
          'pendingPoints': 0,
          'redeemedPoints': 0,
        };
      }
      
      final txSnapshot = await _firestore
        .collection('mlm_points_ledger')
        .where('userId', isEqualTo: userId)
        .orderBy('createdAt', descending: true)
        .limit(20)
        .get();
      
      _transactions = txSnapshot.docs.map((doc) {
        final data = doc.data();
        data['id'] = doc.id;
        return data;
      }).toList();
      
      _isLoading = false;
      notifyListeners();
    } catch (e) {
      _error = 'Failed to load points data';
      _isLoading = false;
      notifyListeners();
      debugPrint('Error loading points wallet: $e');
    }
  }
  
  Future<void> refresh(String userId) async {
    await loadWallet(userId);
  }
  
  String getStatusText(String status) {
    switch (status) {
      case 'pending': return 'Pending';
      case 'available': return 'Available';
      case 'redeemed': return 'Redeemed';
      case 'expired': return 'Expired';
      default: return status;
    }
  }
  
  String getSourceTypeText(String sourceType) {
    switch (sourceType) {
      case 'order': return 'Order Commission';
      case 'referral': return 'Referral Bonus';
      case 'admin': return 'Admin Adjustment';
      case 'bonus': return 'Bonus Points';
      default: return sourceType;
    }
  }
}
